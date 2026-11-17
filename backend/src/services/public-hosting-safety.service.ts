import { database } from '../config/database.js';
import { env, type HostingConfig } from '../config/env.js';
import { AppError } from '../utils/app-error.js';
import { ApplicationRoutingError, ApplicationRoutingService, DEFAULT_INGRESS_SOCKET } from './application-routing.service.js';
import { createCaddyAdminTransport } from './caddy-admin-transport.js';
import { PublicApplicationPolicy } from './public-application-policy.js';
import { containerService } from './container.service.js';
import { RESERVED_WORKLOAD_PORT, workloadAddress } from '../utils/workload-address.js';
import { readFile } from 'node:fs/promises';
import { LINUX_BOOT_ID, readLinuxBootId } from '../utils/linux-boot.js';
import { projectIdFromHostname, type RouteTarget } from '../utils/project-hostname.js';

const bindingKey = { id: 1 };
const routedState = {
  OR: [{ activeDeploymentId: { not: null } }, { routingOperation: { not: null } }],
};
const legacyBuild = { status: 'BUILDING', guardedBuild: false, buildNetworkId: null } as const;
const targetSelect = { projectId: true, hostPort: true, publicAddressIndex: true } as const;

export async function hasRecordedPublicTarget(
  db: Pick<typeof database, 'project'>, projectId: string, operatorId: string, target: RouteTarget,
): Promise<boolean> {
  const project = await db.project.findUnique({ where: { id: projectId, userId: operatorId },
    select: { activeDeployment: { select: targetSelect }, routingDeployment: { select: targetSelect } } });
  return project !== null && [project.activeDeployment, project.routingDeployment].some((deployment) =>
    deployment?.publicAddressIndex != null && deployment.projectId === projectId && deployment.hostPort === target.port &&
    workloadAddress(deployment.publicAddressIndex) === target.address);
}

export async function assertReservedWorkloadPortIsPrivileged() {
  const first = Number((await readFile('/proc/sys/net/ipv4/ip_unprivileged_port_start', 'utf8')).trim());
  if (!Number.isInteger(first) || first <= RESERVED_WORKLOAD_PORT) {
    throw new Error('Public workloads require a privileged host loopback port');
  }
}

export async function assertPublicWorkloadInventory(
  hosting: HostingConfig,
  db = database,
  inventory = () => containerService.inventoryPublicStartup(),
  legacyProjectId = hosting.publicHosting?.legacyProjectId,
): Promise<void> {
  const publicMode = hosting.publicHosting;
  if (publicMode === undefined) return;
  const policy = new PublicApplicationPolicy(hosting, db);
  for (const runtime of await inventory()) {
    const deployment = await db.deployment.findUnique({
      where: { id: runtime.deploymentId },
      include: { project: { select: { id: true, userId: true, repositoryUrl: true, branch: true,
        activeDeploymentId: true, routingOperation: true, routingDeploymentId: true } } },
    });
    if (deployment?.containerId !== runtime.containerId ||
      runtime.hostAddress !== workloadAddress(deployment.publicAddressIndex) ||
      (deployment.publicAddressIndex === null &&
        (deployment.projectId !== legacyProjectId || (deployment.project.activeDeploymentId !== deployment.id &&
          (deployment.project.routingOperation !== 'RETIRE' || deployment.project.routingDeploymentId !== deployment.id))))) {
      throw new Error('Make every unmanaged or unverified Docker workload incapable of starting before entering public mode');
    }
    await policy.assertApproved(deployment.project, deployment.commitHash);
  }
}

// Keep the ingress binding and generation even if every project is withdrawn.
export const assertPublicHostingStartup = async (
  hosting: HostingConfig = env.hosting,
  db = database,
  readRoutes = (socket: string, suffix: string, ingressSocket?: string) =>
    new ApplicationRoutingService(createCaddyAdminTransport(socket), suffix, undefined,
      ingressSocket === undefined ? undefined : { ingressSocket }).readDashboardTargets(),
  inventory?: () => ReturnType<typeof containerService.inventoryPublicStartup>,
  recoverPending?: () => Promise<void>,
  readBootId = readLinuxBootId,
): Promise<void> => {
  const existing = await db.publicRoutingBinding.findUnique({ where: bindingKey });
  const mode = hosting.publicHosting;
  const socket = hosting.adminSocketPath;
  if (mode === undefined || socket === undefined) {
    if (existing !== null || mode !== undefined) {
      throw new Error('The public routing binding must stay enabled with its original Caddy socket');
    }
    if (await db.projectPublicApproval.count() !== 0) {
      throw new Error('Existing public approvals require starting in public mode');
    }
    if (socket !== undefined) {
      // The local route parser rejects a live public proxy layout.
      await readRoutes(socket, hosting.hostnameSuffix);
    } else if (await db.project.findFirst({ where: routedState, select: { id: true } }) !== null) {
      throw new Error('Verify withdrawal of previous Caddy routes before starting without an admin socket');
    }
    return;
  }

  const legacyProjectId = existing === null ? mode.legacyProjectId ?? null : existing.projectId;
  const desired = { projectId: legacyProjectId, hostnameSuffix: hosting.hostnameSuffix, adminSocketPath: socket,
    ingressSocketPath: mode.ingressSocketPath ?? DEFAULT_INGRESS_SOCKET };
  const checkBinding = (binding: typeof desired) => {
    if (binding.projectId !== desired.projectId || binding.hostnameSuffix !== desired.hostnameSuffix ||
      binding.adminSocketPath !== desired.adminSocketPath || binding.ingressSocketPath !== desired.ingressSocketPath) {
      throw new Error('Public routing configuration differs from the recorded binding');
    }
  };
  if (existing !== null) checkBinding(existing);
  if (mode.legacyProjectId !== undefined && mode.legacyProjectId !== legacyProjectId) {
    throw new Error('The legacy project setting differs from the recorded binding');
  }
  const needsCutover = existing?.cutoverBootId == null;
  if (await db.user.findUnique({ where: { id: mode.operatorId }, select: { id: true } }) === null) {
    throw new Error('The configured public hosting operator does not exist');
  }

  await db.projectPublicApproval.count();
  const live = await readRoutes(socket, hosting.hostnameSuffix, desired.ingressSocketPath).catch(async (error: unknown) => {
    // A sealed instance can expose pending status and retry while the socket is
    // unavailable. New starts remain blocked by the durable pending record.
    if (!needsCutover && error instanceof ApplicationRoutingError && error.code === 'unavailable' &&
      await db.projectPublicApproval.findFirst({
        where: { revokedAt: { not: null }, withdrawnAt: null }, select: { projectId: true },
      }) !== null) return null;
    throw error;
  });
  if (needsCutover && live?.size !== 0) throw new Error('First public cutover requires the deny-only Caddy bootstrap');
  if (legacyProjectId !== null) {
    const project = await db.project.findUnique({
      where: { id: legacyProjectId },
      select: {
        id: true, userId: true, repositoryUrl: true, branch: true,
        activeDeployment: { select: { commitHash: true } },
      },
    });
    if ((project === null && existing === null) ||
      project !== null && project.userId !== mode.operatorId) {
      throw new Error('The public routing project must belong to the configured operator');
    }
    if (project !== null) {
      const approval = await new PublicApplicationPolicy(hosting, db).read(project);
      // A durable revocation must be able to boot so it can finish withdrawal.
      const revoked = approval !== null && approval.revokedAt !== null;
      if (!revoked && project.activeDeployment !== null &&
        (approval === null || project.activeDeployment.commitHash === null ||
          !approval.commits.includes(project.activeDeployment.commitHash))) {
        throw new Error('The active public SHA must be approved before starting with this configuration');
      }
    }
  }
  if (!needsCutover && live !== null) {
    for (const [host, target] of live) {
      const id = projectIdFromHostname(host, hosting.hostnameSuffix);
      if (id === undefined || !await hasRecordedPublicTarget(db, id, mode.operatorId, target)) {
        await db.publicRoutingBinding.update({
          where: { ...bindingKey, ...desired }, data: { routeRecoveryRequired: true },
        });
        break;
      }
    }
  }
  if (needsCutover) {
    const oldState = await db.project.findFirst({
      where: {
        ...(legacyProjectId === null ? {} : { id: { not: legacyProjectId } }),
        ...routedState,
      },
      select: { id: true },
    });
    if (oldState !== null) throw new Error('Withdraw private routes before first starting public hosting');
  }
  let cutoverBootId: string | undefined;
  if (needsCutover) {
    const previousBoot = process.env.APP_PUBLIC_PRE_CUTOVER_BOOT_ID;
    if (previousBoot === undefined || !LINUX_BOOT_ID.test(previousBoot)) {
      throw new Error('Record APP_PUBLIC_PRE_CUTOVER_BOOT_ID during offline maintenance before rebooting for public cutover');
    }
    cutoverBootId = await readBootId();
    if (!LINUX_BOOT_ID.test(cutoverBootId) || cutoverBootId === previousBoot) {
      throw new Error('Public cutover requires a host reboot after recording the previous boot ID');
    }
  } else {
    if (await db.deployment.findFirst({ where: legacyBuild, select: { id: true } }) !== null) {
      throw new Error('An unguarded Docker build appeared after public cutover');
    }
  }
  await recoverPending?.();
  await assertPublicWorkloadInventory(hosting, db, inventory, legacyProjectId ?? undefined);
  if (cutoverBootId !== undefined) {
    await db.$transaction(async (tx) => {
      const bound = await tx.publicRoutingBinding.upsert({
        where: bindingKey, create: { ...bindingKey, ...desired, cutoverBootId }, update: { cutoverBootId },
      });
      checkBinding(bound);
      await tx.deployment.updateMany({ where: legacyBuild,
        data: { status: 'FAILED', finishedAt: new Date(), errorMessage: 'Legacy build ended during the public cutover reboot' } });
    });
  }
};

export const assertNoPendingPublicWithdrawal = async (projectId: string): Promise<void> => {
  const pending = await database.projectPublicApproval.findFirst({
    where: { projectId, revokedAt: { not: null }, withdrawnAt: null },
    select: { projectId: true },
  }).catch(() => { throw new AppError(503, 'Unable to verify public withdrawal state'); });
  if (pending !== null) throw new AppError(503, 'Public withdrawal is pending for this project');
};

export const assertPublicWorkloadReady = async (projectId: string): Promise<void> => {
  await assertNoPendingPublicWithdrawal(projectId);
  const build = await database.deployment.findFirst({
    where: { projectId, buildNetworkId: { not: null } }, select: { id: true },
  });
  if (build !== null) throw new AppError(503, 'An earlier Docker build is still unconfirmed for this project');
};
