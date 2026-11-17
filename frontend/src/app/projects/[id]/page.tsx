"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { DeploymentLogsPanel } from "@/components/deployment-logs-panel";
import { DeploymentMetricsPanel } from "@/components/deployment-metrics-panel";
import { GitHubWebhookPanel } from "@/components/github-webhook-panel";
import { ProjectHosting } from "@/components/project-hosting";
import { useAuth } from "@/context/auth-context";
import {
  ApiError,
  PROJECT_REFRESH_INTERVAL_MS,
  deploymentApi,
  projectApi,
  type Deployment,
  type Project,
  type PublicApproval,
} from "@/lib/api";
import {
  DEPLOYMENT_STATUS_LABELS,
  DEPLOYMENT_STATUS_STYLES,
  formatDateTime,
  isDeploymentInProgress,
} from "@/lib/deployments";

type DeploymentAction = "deploy" | "stop" | "restart" | "redeploy";

const ACTION_LABELS: Record<DeploymentAction, string> = {
  deploy: "Deploy",
  stop: "Stop",
  restart: "Restart",
  redeploy: "Redeploy",
};

const ACTION_PENDING_LABELS: Record<DeploymentAction, string> = {
  deploy: "Deploying…",
  stop: "Stopping…",
  restart: "Restarting…",
  redeploy: "Redeploying…",
};

const NEW_DEPLOYMENT_POLL_INTERVAL_MS = 750;
const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/;

const isValidHealthCheckPath = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 1024 &&
  value.startsWith("/") &&
  !value.startsWith("//") &&
  /^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]+$/.test(value) &&
  !/[\u0000-\u001f\u007f\\?#]/.test(value);

const APPLICATION_TYPE_LABELS: Record<
  NonNullable<Deployment["applicationType"]>,
  string
> = {
  DOCKERFILE: "Dockerfile",
  NODE: "Node.js",
  PYTHON: "Python",
};

function StatusBadge({ status }: { status: Deployment["status"] }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${DEPLOYMENT_STATUS_STYLES[status]}`}
    >
      {DEPLOYMENT_STATUS_LABELS[status]}
    </span>
  );
}

function ProjectDetailsSkeleton() {
  return (
    <div className="animate-pulse" role="status" aria-label="Loading project details">
      <div className="h-5 w-32 rounded bg-slate-200" />
      <div className="mt-7 h-10 w-72 max-w-full rounded bg-slate-200" />
      <div className="mt-4 h-5 w-full max-w-xl rounded bg-slate-200" />
      <div className="mt-9 grid gap-5 lg:grid-cols-3">
        <div className="h-72 rounded-2xl border border-slate-200 bg-white lg:col-span-2" />
        <div className="h-72 rounded-2xl border border-slate-200 bg-white" />
      </div>
      <div className="mt-5 h-80 rounded-2xl border border-slate-200 bg-white" />
    </div>
  );
}

export default function ProjectDetailsPage() {
  const { id: projectId } = useParams<{ id: string }>();
  return <ProjectDetails key={projectId} projectId={projectId} />;
}

function ProjectDetails({ projectId }: { projectId: string }) {
  const { logout, token } = useAuth();
  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [approval, setApproval] = useState<PublicApproval | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<"approve" | "revoke" | null>(null);
  const [commitInput, setCommitInput] = useState("");
  const [selectedCommit, setSelectedCommit] = useState("");
  const [pendingAction, setPendingAction] = useState<DeploymentAction | null>(null);
  const [pendingRollbackId, setPendingRollbackId] = useState<string | null>(null);
  const [healthCheckPath, setHealthCheckPath] = useState("/");
  const [isSavingHealthCheck, setIsSavingHealthCheck] = useState(false);
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string | null>(
    null,
  );
  const requestId = useRef(0);

  const loadProject = useCallback(
    async (signal?: AbortSignal, showLoading = true, selectedId?: string) => {
      if (token === null) return;

      const id = ++requestId.current;
      if (showLoading) setIsLoading(true);

      try {
        const [projectResult, deploymentResult] = await Promise.all([
          projectApi.get(token, projectId, signal),
          projectApi.listDeployments(token, projectId, signal),
        ]);
        let approvalResult: PublicApproval | null = null;
        let approvalFailure: string | null = null;
        if (projectResult.publicHostingEnabled) {
          try {
            approvalResult = await projectApi.getPublicApproval(token, projectId, signal);
          } catch (error) {
            if (error instanceof ApiError && error.status === 401) throw error;
            approvalFailure = error instanceof Error ? error.message : "Unable to verify public hosting approval.";
          }
        }
        if (signal?.aborted || id !== requestId.current) return;
        setProject(projectResult);
        setApproval(approvalResult);
        setApprovalError(approvalFailure);
        if (showLoading) setHealthCheckPath(projectResult.healthCheckPath);
        setDeployments(deploymentResult);
        setLoadError(null);
        setSelectedDeploymentId((current) =>
          selectedId ?? (
            current !== null && deploymentResult.some((deployment) => deployment.id === current)
              ? current
              : (projectResult.activeDeployment?.id ?? deploymentResult[0]?.id ?? null)
          ),
        );
      } catch (requestError: unknown) {
        if (signal?.aborted || id !== requestId.current) return;

        if (requestError instanceof ApiError && requestError.status === 401) {
          logout();
          return;
        }

        setLoadError(
          requestError instanceof ApiError && requestError.status === 404
            ? "This project does not exist or you do not have access to it."
            : requestError instanceof Error
              ? requestError.message
              : "Unable to load this project.",
        );
      } finally {
        if (!signal?.aborted && id === requestId.current) setIsLoading(false);
      }
    },
    [logout, projectId, token],
  );

  const trackNewDeployment = useCallback(
    async (knownDeploymentIds: Set<string>, signal: AbortSignal) => {
      if (token === null) return;

      while (!signal.aborted) {
        try {
          const deploymentResult = await projectApi.listDeployments(
            token,
            projectId,
            signal,
          );
          const newDeployment = deploymentResult.find(
            (deployment) => !knownDeploymentIds.has(deployment.id),
          );

          if (newDeployment !== undefined && !signal.aborted) {
            setDeployments(deploymentResult);
            setSelectedDeploymentId(newDeployment.id);
            return;
          }
        } catch (requestError: unknown) {
          if (signal.aborted) return;
          if (requestError instanceof ApiError && requestError.status === 401) {
            logout();
          }
          return;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, NEW_DEPLOYMENT_POLL_INTERVAL_MS),
        );
      }
    },
    [logout, projectId, token],
  );

  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    const refresh = async (initial = false) => {
      if (controller.signal.aborted) return;
      if (initial || !document.hidden) await loadProject(controller.signal, initial);
      if (!controller.signal.aborted) {
        timer = window.setTimeout(() => void refresh(), PROJECT_REFRESH_INTERVAL_MS);
      }
    };
    queueMicrotask(() => void refresh(true));
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [loadProject]);

  const latestDeployment = deployments[0] ?? null;
  const activeDeployment = project?.activeDeployment ?? null;
  const runningDeployment = project?.hostingStatus === "DISABLED"
    ? deployments.find((deployment) => deployment.status === "RUNNING" && deployment.containerId !== null)
    : deployments.find((deployment) => deployment.id === activeDeployment?.id);
  const lastStoppedDeployment = deployments
    .filter((deployment) => deployment.status === "STOPPED" && deployment.containerId !== null)
    .sort((a, b) => (b.finishedAt ?? b.updatedAt).localeCompare(a.finishedAt ?? a.updatedAt))[0];
  const restartTarget = runningDeployment ?? (activeDeployment === null ? lastStoppedDeployment : undefined);
  const selectedDeployment =
    deployments.find((deployment) => deployment.id === selectedDeploymentId) ?? null;
  const deploymentBusy =
    latestDeployment !== null && isDeploymentInProgress(latestDeployment.status);
  const actionsBusy =
    pendingAction !== null || pendingRollbackId !== null || pendingApproval !== null || isSavingHealthCheck || deploymentBusy;
  const publicHosting = project?.publicHostingEnabled === true;
  const approvalStatus = approval?.status === "APPROVED" && project?.approvalStatus !== "APPROVED"
    ? "UNKNOWN"
    : approval?.status ?? "UNKNOWN";
  const approvedCommits = approvalStatus === "APPROVED" && approval?.status === "APPROVED" ? approval.commits : [];
  const canLaunchRevision = (sha: string | null | undefined) =>
    !publicHosting || (sha != null && approvedCommits.includes(sha));
  const deploymentCommit = approvedCommits.includes(selectedCommit) ? selectedCommit : "";
  const canApprove = publicHosting && approvalStatus !== "UNKNOWN" && approvalStatus !== "WITHDRAWAL_PENDING";
  const canRevoke = publicHosting && (approvalStatus === "APPROVED" || approvalStatus === "WITHDRAWAL_PENDING");
  const actionAvailability = {
    deploy: latestDeployment === null && canLaunchRevision(deploymentCommit) && !actionsBusy,
    stop: runningDeployment?.status === "RUNNING" && runningDeployment.containerId !== null &&
      approvalStatus !== "WITHDRAWAL_PENDING" && !actionsBusy,
    restart: restartTarget?.containerId != null && (!publicHosting || restartTarget.publicAddressIndex != null) &&
      canLaunchRevision(restartTarget.commitHash) &&
      (restartTarget.status === "RUNNING" || restartTarget.status === "STOPPED") && !actionsBusy,
    redeploy: latestDeployment !== null && canLaunchRevision(deploymentCommit) && !actionsBusy,
  };

  const approveRevision = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (token === null || project === null || actionsBusy || !canApprove) return;
    const commitHash = commitInput.trim().toLowerCase();
    setActionSuccess(null);
    if (!FULL_COMMIT_SHA.test(commitHash)) {
      setActionError("Enter a full 40-character Git commit SHA.");
      return;
    }
    setPendingApproval("approve");
    setActionError(null);
    try {
      const result = await projectApi.approveRevision(token, projectId, {
        repositoryUrl: project.repositoryUrl,
        branch: project.branch,
        commitHash,
      });
      requestId.current += 1;
      setApproval(result);
      setCommitInput("");
      setActionSuccess("Revision approved. Select the revision to deploy.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        logout();
        return;
      }
      setActionError(error instanceof Error ? error.message : "The revision could not be approved.");
    } finally {
      await loadProject(undefined, false);
      setPendingApproval(null);
    }
  };

  const revokeHosting = async () => {
    if (token === null || actionsBusy || !canRevoke) return;
    if (approvalStatus === "APPROVED" &&
      !window.confirm("Revoke public hosting? This withdraws the website, removes its containers, and revokes all approved revisions.")) return;

    setPendingApproval("revoke");
    setActionError(null);
    setActionSuccess(null);
    try {
      const result = await projectApi.revokePublicApproval(token, projectId);
      requestId.current += 1;
      setApproval(result);
      setSelectedCommit("");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        logout();
        return;
      }
      setActionError(error instanceof Error ? error.message : "Public hosting could not be revoked.");
    } finally {
      await loadProject(undefined, false);
      setPendingApproval(null);
    }
  };

  const runAction = async (action: DeploymentAction) => {
    if (token === null || !actionAvailability[action]) return;
    if (action === "stop" && !window.confirm("Stop the running deployment? The application will become unavailable.")) return;
    if (action === "restart" && restartTarget?.status === "RUNNING" &&
      !window.confirm("Restart the running deployment? The application may be briefly unavailable.")) return;

    setPendingAction(action);
    setActionError(null);
    setActionSuccess(null);
    const trackingController = new AbortController();
    const tracksNewDeployment = action === "deploy" || action === "redeploy";
    const trackingPromise = tracksNewDeployment
      ? trackNewDeployment(
          new Set(deployments.map((deployment) => deployment.id)),
          trackingController.signal,
        )
      : Promise.resolve();

    try {
      let actionDeployment: Deployment | null = null;
      const commitHash = publicHosting ? deploymentCommit : undefined;

      if (action === "deploy") {
        actionDeployment = await deploymentApi.deploy(token, projectId, commitHash);
      } else if (action === "stop" && runningDeployment !== undefined) {
        actionDeployment = await deploymentApi.stop(token, runningDeployment.id);
      } else if (action === "restart" && restartTarget !== undefined) {
        actionDeployment = await deploymentApi.restart(token, restartTarget.id);
      } else if (action === "redeploy" && latestDeployment !== null) {
        actionDeployment = await deploymentApi.redeploy(token, latestDeployment.id, commitHash);
      }

      trackingController.abort();
      if (actionDeployment !== null) {
        setSelectedDeploymentId(actionDeployment.id);
      }
      await loadProject(undefined, false, actionDeployment?.id);
      if (actionDeployment?.status === "STOPPED") setActionSuccess("Deployment stopped.");
      if (actionDeployment?.status === "RUNNING") setActionSuccess("Deployment is running.");
    } catch (requestError: unknown) {
      if (requestError instanceof ApiError && requestError.status === 401) {
        logout();
        return;
      }

      setActionError(
        requestError instanceof Error
          ? requestError.message
          : `${ACTION_LABELS[action]} could not be completed.`,
      );
      trackingController.abort();
      await loadProject(undefined, false);
    } finally {
      trackingController.abort();
      await trackingPromise;
      setPendingAction(null);
    }
  };

  const canRollback = (deployment: Deployment) =>
    deployment.status === "STOPPED" && deployment.commitHash !== null &&
    canLaunchRevision(deployment.commitHash) && !actionsBusy;

  const runRollback = async (sourceDeployment: Deployment) => {
    if (token === null || !canRollback(sourceDeployment)) return;
    if (!window.confirm(`Roll back to revision ${sourceDeployment.commitHash}?`)) return;

    setPendingRollbackId(sourceDeployment.id);
    setActionError(null);
    setActionSuccess(null);
    const trackingController = new AbortController();
    const trackingPromise = trackNewDeployment(
      new Set(deployments.map((deployment) => deployment.id)),
      trackingController.signal,
    );

    try {
      const rollbackDeployment = await deploymentApi.rollback(
        token,
        sourceDeployment.id,
      );
      trackingController.abort();
      setSelectedDeploymentId(rollbackDeployment.id);
      await loadProject(undefined, false, rollbackDeployment.id);
      setActionSuccess(
        `Rollback completed. Deployment ${rollbackDeployment.id} is running.`,
      );
    } catch (requestError: unknown) {
      if (requestError instanceof ApiError && requestError.status === 401) {
        logout();
        return;
      }

      setActionError(
        requestError instanceof Error
          ? requestError.message
          : "Rollback could not be completed.",
      );
      trackingController.abort();
      await loadProject(undefined, false);
    } finally {
      trackingController.abort();
      await trackingPromise;
      setPendingRollbackId(null);
    }
  };

  const saveHealthCheckPath = async () => {
    if (token === null || project === null || actionsBusy) return;
    const normalizedPath = healthCheckPath.trim();
    if (!isValidHealthCheckPath(normalizedPath)) {
      setActionError("Health-check path must start with /, such as /health.");
      return;
    }

    setIsSavingHealthCheck(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      const updatedProject = await projectApi.updateHealthCheckPath(
        token,
        project.id,
        normalizedPath,
      );
      setHealthCheckPath(updatedProject.healthCheckPath);
      await loadProject(undefined, false);
      setActionSuccess("Health-check path updated.");
    } catch (requestError: unknown) {
      if (requestError instanceof ApiError && requestError.status === 401) {
        logout();
        return;
      }
      setActionError(
        requestError instanceof Error
          ? requestError.message
          : "Health-check path could not be updated.",
      );
    } finally {
      setIsSavingHealthCheck(false);
    }
  };

  const primaryAction = pendingAction === "deploy" || latestDeployment === null ? "deploy" : "redeploy";
  const visibleActions: DeploymentAction[] = publicHosting
    ? [primaryAction, "stop", "restart"]
    : ["deploy", "stop", "restart", "redeploy"];
  const deploymentActions = (
    <div className="flex flex-wrap gap-3" aria-label="Deployment actions">
      {visibleActions.map((action) => (
          <button
            className={action === "deploy" || action === "redeploy" ? "button-primary" : "button-secondary"}
            disabled={!actionAvailability[action]}
            key={action}
            onClick={() => void runAction(action)}
            type="button"
          >
            {pendingAction === action ? ACTION_PENDING_LABELS[action] : ACTION_LABELS[action]}
          </button>
      ))}
    </div>
  );

  return (
    <div className="flex-1 bg-slate-50 px-6 py-10 lg:px-8 lg:py-12">
      <div className="mx-auto w-full max-w-7xl">
        {isLoading ? <ProjectDetailsSkeleton /> : null}

        {!isLoading && loadError !== null ? (
          <div className="rounded-2xl border border-red-200 bg-white px-6 py-12 text-center shadow-sm">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-red-50 text-lg font-semibold text-red-700">
              !
            </div>
            <h1 className="mt-4 text-xl font-semibold text-slate-950">
              Project could not be loaded
            </h1>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
              {loadError}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link className="button-secondary" href="/dashboard">
                Back to projects
              </Link>
              <button
                className="button-primary"
                onClick={() => void loadProject()}
                type="button"
              >
                Try again
              </button>
            </div>
          </div>
        ) : null}

        {!isLoading && loadError === null && project !== null ? (
          <>
            <Link
              className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-slate-950"
              href="/dashboard"
            >
              <span aria-hidden="true">←</span> Back to projects
            </Link>

            <div className="mt-6 flex flex-col justify-between gap-6 xl:flex-row xl:items-end">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-blue-700">Project details</p>
                <h1 className="mt-2 break-words text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                  {project.name}
                </h1>
                <a
                  className="mt-3 block break-all text-sm font-medium text-blue-700 hover:text-blue-800 hover:underline"
                  href={project.repositoryUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {project.repositoryUrl}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </div>

              {!publicHosting && deploymentActions}
            </div>

            {deploymentBusy ? (
              <div
                className="mt-6 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800"
                role="status"
              >
                Deployment is {DEPLOYMENT_STATUS_LABELS[latestDeployment.status].toLowerCase()}.
                Actions will be available when it finishes.
              </div>
            ) : null}

            {actionError !== null ? (
              <div
                className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
                role="alert"
              >
                {actionError}
              </div>
            ) : null}

            {actionSuccess !== null ? (
              <div
                className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
                role="status"
              >
                {actionSuccess}
              </div>
            ) : null}

            <div className="mt-8 grid gap-5 lg:grid-cols-3">
              <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-2">
                <h2 className="text-lg font-semibold tracking-tight text-slate-950">
                  {publicHosting ? "Public Hosting" : "Application hosting"}
                </h2>
                <div className="mt-4 flex flex-wrap items-start justify-between gap-5 border-b border-slate-100 pb-5">
                  <ProjectHosting
                    project={publicHosting ? { ...project, approvalStatus } : project}
                    isChangingRoute={pendingApproval === "revoke" || pendingAction === "stop" || pendingAction === "restart"}
                  />
                  <div>
                    <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                      Active deployment
                    </p>
                    {activeDeployment === null ? (
                      <p className="mt-2 text-sm text-slate-600">No active hosted deployment</p>
                    ) : (
                      <>
                        <div className="mt-2"><StatusBadge status={activeDeployment.status} /></div>
                        <p className="mt-2 break-all font-mono text-xs text-slate-800">{activeDeployment.id}</p>
                        {activeDeployment.commitHash !== null ? (
                          <p className="mt-1 break-all font-mono text-xs text-slate-600">{activeDeployment.commitHash}</p>
                        ) : null}
                      </>
                    )}
                  </div>
                  {project.hostingStatus === "DISABLED" &&
                  runningDeployment?.hostPort != null &&
                  runningDeployment.publicAddressIndex == null ? (
                    <a
                      className="button-secondary"
                      href={`http://localhost:${runningDeployment.hostPort}`}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open local Docker port
                    </a>
                  ) : null}
                </div>
                {publicHosting && (
                  <div className="space-y-5 border-b border-slate-100 py-5">
                    {approvalError && (
                      <div className="flex flex-wrap items-center gap-3">
                        <p className="text-sm text-red-700" role="alert">{approvalError}</p>
                        <button className="button-secondary" onClick={() => void loadProject(undefined, false)} type="button">
                          Refresh approval
                        </button>
                      </div>
                    )}
                    {approvalStatus === "WITHDRAWAL_PENDING" && (
                      <p className="text-sm text-amber-800" role="status">
                        Approval is revoked. The backend is still verifying route and workload removal.
                      </p>
                    )}
                    {approvalStatus === "REVOKED" && (
                      <p className="text-sm text-slate-700" role="status">Public hosting withdrawal verified.</p>
                    )}
                    {canApprove && (
                      <form onSubmit={(event) => void approveRevision(event)} noValidate>
                        <label className="block text-sm font-medium text-slate-800" htmlFor="reviewed-commit">
                          Reviewed Git commit SHA
                        </label>
                        <p className="mt-1 text-sm text-slate-600" id="reviewed-commit-help">
                          Enter the full 40-character SHA you reviewed for this repository and branch.
                        </p>
                        <div className="mt-2 flex flex-wrap items-start gap-2 sm:flex-nowrap">
                          <input
                            aria-describedby="reviewed-commit-help"
                            autoCapitalize="none"
                            autoComplete="off"
                            className="form-input mt-0 min-w-0 font-mono"
                            disabled={actionsBusy}
                            id="reviewed-commit"
                            onChange={(event) => setCommitInput(event.target.value)}
                            spellCheck={false}
                            value={commitInput}
                          />
                          <button className="button-secondary shrink-0" disabled={actionsBusy || !commitInput.trim()} type="submit">
                            {pendingApproval === "approve" ? "Approving…" : approvedCommits.length > 0 ? "Approve another revision" : "Approve revision"}
                          </button>
                        </div>
                      </form>
                    )}
                    <div>
                      <label className="block text-sm font-medium text-slate-800" htmlFor="deployment-revision">
                        Approved revisions
                      </label>
                      <select
                        className="form-input font-mono"
                        disabled={actionsBusy || approvedCommits.length === 0}
                        id="deployment-revision"
                        onChange={(event) => setSelectedCommit(event.target.value)}
                        value={deploymentCommit}
                      >
                        <option value="">{approvedCommits.length ? "Select a deployment revision" : "No approved revisions available"}</option>
                        {approvedCommits.map((commit) => <option key={commit} value={commit}>{commit}</option>)}
                      </select>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      {deploymentActions}
                      {canRevoke && (
                        <button
                          className="button-secondary text-red-700"
                          disabled={actionsBusy}
                          onClick={() => void revokeHosting()}
                          type="button"
                        >
                          {pendingApproval === "revoke" ? "Withdrawing…" : approvalStatus === "WITHDRAWAL_PENDING" ? "Retry withdrawal" : "Revoke public hosting"}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <h3 className="mt-5 text-base font-semibold tracking-tight text-slate-950">
                  Latest deployment attempt
                </h3>

                {latestDeployment === null ? (
                  <div className="mt-6 rounded-xl border border-dashed border-slate-300 px-5 py-10 text-center">
                    <p className="font-medium text-slate-800">No deployments yet</p>
                    <p className="mt-1 text-sm text-slate-500">
                      Use Deploy to build and start this project for the first time.
                    </p>
                  </div>
                ) : (
                  <div className="mt-6">
                    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-5">
                      <StatusBadge status={latestDeployment.status} />
                      <p className="break-all font-mono text-xs text-slate-600">{latestDeployment.id}</p>
                    </div>
                    {latestDeployment.errorMessage && (
                      <p className="mt-4 text-sm text-red-700">{latestDeployment.errorMessage}</p>
                    )}

                    <dl className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-2">
                      <div>
                        <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                          Commit hash
                        </dt>
                        <dd className="mt-1.5 break-all font-mono text-sm text-slate-800">
                          {latestDeployment.commitHash ?? "—"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                          Host port
                        </dt>
                        <dd className="mt-1.5 font-mono text-sm text-slate-800">
                          {latestDeployment.status === "RUNNING" && latestDeployment.hostPort !== null
                            ? latestDeployment.hostPort
                            : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                          Deployment type
                        </dt>
                        <dd className="mt-1.5 text-sm text-slate-800">
                          {latestDeployment.applicationType === null
                            ? "—"
                            : APPLICATION_TYPE_LABELS[
                                latestDeployment.applicationType
                              ]}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                          Created
                        </dt>
                        <dd className="mt-1.5 text-sm text-slate-800">
                          {formatDateTime(latestDeployment.createdAt)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                          Started
                        </dt>
                        <dd className="mt-1.5 text-sm text-slate-800">
                          {formatDateTime(latestDeployment.startedAt)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                          Finished
                        </dt>
                        <dd className="mt-1.5 text-sm text-slate-800">
                          {formatDateTime(latestDeployment.finishedAt)}
                        </dd>
                      </div>
                    </dl>
                  </div>
                )}
              </section>

              <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-lg font-semibold tracking-tight text-slate-950">
                  Configuration
                </h2>
                <dl className="mt-6 space-y-5">
                  <div>
                    <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                      Project name
                    </dt>
                    <dd className="mt-1.5 break-words text-sm font-medium text-slate-800">
                      {project.name}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                      Repository
                    </dt>
                    <dd className="mt-1.5 break-all text-sm text-slate-800">
                      {project.repositoryUrl}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                      Branch
                    </dt>
                    <dd className="mt-1.5 break-all font-mono text-sm text-slate-800">
                      {project.branch}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                      Container port
                    </dt>
                    <dd className="mt-1.5 font-mono text-sm text-slate-800">
                      {project.containerPort}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                      Health-check path
                    </dt>
                    <dd className="mt-2">
                      <input
                        aria-label="Health-check path"
                        autoCapitalize="none"
                        autoComplete="off"
                        className="form-input mt-0 font-mono"
                        disabled={actionsBusy}
                        maxLength={1024}
                        onChange={(event) =>
                          setHealthCheckPath(event.target.value)
                        }
                        value={healthCheckPath}
                      />
                      <button
                        className="button-secondary mt-3"
                        disabled={
                          actionsBusy ||
                          healthCheckPath.trim() === project.healthCheckPath
                        }
                        onClick={() => void saveHealthCheckPath()}
                        type="button"
                      >
                        {isSavingHealthCheck ? "Saving…" : "Save path"}
                      </button>
                    </dd>
                  </div>
                </dl>
              </section>
            </div>

            {token !== null ? (
              <>
                {!publicHosting && (
                  <GitHubWebhookPanel onUnauthorized={logout} projectId={project.id} token={token} />
                )}
                <DeploymentMetricsPanel
                  deployment={selectedDeployment}
                  key={`${selectedDeployment?.id ?? "no-deployment"}:${selectedDeployment?.status ?? "none"}`}
                  onUnauthorized={logout}
                  token={token}
                />
                <DeploymentLogsPanel
                  deployments={deployments}
                  key={selectedDeploymentId ?? "no-deployment"}
                  onSelectDeployment={setSelectedDeploymentId}
                  selectedDeploymentId={selectedDeploymentId}
                  token={token}
                />
              </>
            ) : null}

            <section className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-6 py-5">
                <h2 className="text-lg font-semibold tracking-tight text-slate-950">
                  Deployment history
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Previous deployments remain available as a permanent project record.
                </p>
              </div>

              {deployments.length === 0 ? (
                <p className="px-6 py-10 text-center text-sm text-slate-500">
                  No deployment history yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-5xl border-collapse text-left text-sm">
                    <thead className="bg-slate-50 text-xs tracking-wide text-slate-500 uppercase">
                      <tr>
                        <th className="px-6 py-3 font-semibold" scope="col">Deployment ID</th>
                        <th className="px-4 py-3 font-semibold" scope="col">Status</th>
                        <th className="px-4 py-3 font-semibold" scope="col">Commit hash</th>
                        <th className="px-4 py-3 font-semibold" scope="col">Type</th>
                        <th className="px-4 py-3 font-semibold" scope="col">Created</th>
                        <th className="px-4 py-3 font-semibold" scope="col">Started</th>
                        <th className="px-6 py-3 font-semibold" scope="col">Finished</th>
                        <th className="px-6 py-3 font-semibold" scope="col">Rollback</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {deployments.map((deployment) => (
                        <tr
                          className={
                            deployment.id === selectedDeploymentId
                              ? "bg-blue-50/60 text-slate-700"
                              : "text-slate-700"
                          }
                          key={deployment.id}
                        >
                          <td className="px-6 py-4 font-mono text-xs text-slate-800">
                            <button
                              aria-pressed={deployment.id === selectedDeploymentId}
                              className="text-left hover:text-blue-700 hover:underline"
                              onClick={() => setSelectedDeploymentId(deployment.id)}
                              title="Show live events for this deployment"
                              type="button"
                            >
                              {deployment.id}
                            </button>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-col items-start gap-2">
                              <StatusBadge status={deployment.status} />
                              {deployment.id === activeDeployment?.id ? (
                                <span className="text-xs font-semibold text-emerald-700">
                                  Active deployment
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td className="max-w-52 truncate px-4 py-4 font-mono text-xs" title={deployment.commitHash ?? undefined}>
                            {deployment.commitHash ?? "—"}
                          </td>
                          <td className="whitespace-nowrap px-4 py-4">
                            {deployment.applicationType === null
                              ? "—"
                              : APPLICATION_TYPE_LABELS[
                                  deployment.applicationType
                                ]}
                          </td>
                          <td className="whitespace-nowrap px-4 py-4">
                            {formatDateTime(deployment.createdAt)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-4">
                            {formatDateTime(deployment.startedAt)}
                          </td>
                          <td className="whitespace-nowrap px-6 py-4">
                            {formatDateTime(deployment.finishedAt)}
                          </td>
                          <td className="whitespace-nowrap px-6 py-4">
                            {deployment.status === "STOPPED" &&
                            deployment.commitHash !== null ? (
                              <button
                                className="button-secondary"
                                disabled={!canRollback(deployment)}
                                onClick={() => void runRollback(deployment)}
                                type="button"
                              >
                                {pendingRollbackId === deployment.id
                                  ? "Rolling back…"
                                  : "Rollback"}
                              </button>
                            ) : deployment.rollbackSourceDeploymentId !== null ? (
                              <span
                                className="text-xs text-slate-500"
                                title={deployment.rollbackSourceDeploymentId}
                              >
                                From {deployment.rollbackSourceDeploymentId.slice(0, 8)}
                              </span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
