import { database } from '../config/database.js';
import { env, type HostingConfig } from '../config/env.js';
import { AppError } from '../utils/app-error.js';
import { parsePublicCommit } from '../utils/git-revision.js';

export type ApprovalProject = { id: string; userId: string; repositoryUrl: string; branch: string };
export type ApprovalDatabase = Pick<typeof database, 'projectPublicApproval'>;

export const assertPublicOperator = (userId: string, hosting = env.hosting): void => {
  if (hosting.publicHosting !== undefined && userId !== hosting.publicHosting.operatorId) {
    throw new AppError(403, 'Public hosting management requires the configured operator');
  }
};

export const assertApprovalSource = (project: ApprovalProject, source: { repositoryUrl: string; branch: string }): void => {
  if (project.repositoryUrl.toLowerCase() !== source.repositoryUrl.toLowerCase() || project.branch !== source.branch) {
    throw new AppError(403, 'The repository or branch does not match the project source');
  }
};

export class PublicApplicationPolicy {
  constructor(
    private readonly hosting: HostingConfig = env.hosting,
    private readonly db: ApprovalDatabase = database,
  ) {}

  public async read(project: ApprovalProject, db = this.db, commitHash?: string) {
    assertPublicOperator(project.userId, this.hosting);
    const stored = await db.projectPublicApproval.findUnique({
      where: { projectId: project.id },
      include: { revisions: { where: { revokedAt: null, ...(commitHash === undefined ? {} : { commitHash }) },
        orderBy: { commitHash: 'asc' } } },
    }).catch(() => {
      throw new AppError(503, 'Unable to verify public hosting approval');
    });
    if (stored !== null) {
      assertApprovalSource(project, stored);
      return {
        source: 'DATABASE' as const,
        repositoryUrl: stored.repositoryUrl, branch: stored.branch, approvedById: stored.approvedById,
        approvedAt: stored.approvedAt, revokedAt: stored.revokedAt, withdrawnAt: stored.withdrawnAt,
        commits: stored.revisions.map(({ commitHash }) => commitHash),
      };
    }
    const legacy = this.hosting.publicApp;
    if (legacy?.projectId !== project.id) return null;
    assertApprovalSource(project, legacy);
    return {
      source: 'LEGACY' as const,
      repositoryUrl: legacy.repositoryUrl, branch: legacy.branch, approvedById: project.userId,
      approvedAt: null, revokedAt: null, withdrawnAt: null, commits: [...legacy.commits].sort(),
    };
  }

  public async assertApproved(project: ApprovalProject, commitHash: string | null, db = this.db): Promise<void> {
    if (this.hosting.publicHosting === undefined) return;
    const approval = await this.read(project, db, commitHash ?? undefined);
    if (approval?.revokedAt !== null) {
      throw new AppError(403, 'Public hosting has not been approved for this project');
    }
    if (commitHash === null || !approval.commits.includes(commitHash)) {
      throw new AppError(403, 'This Git revision has not been approved for public hosting');
    }
  }

  public async selectCommit(project: ApprovalProject, sha: string | undefined): Promise<string | undefined> {
    const commit = this.hosting.publicHosting === undefined ? sha : parsePublicCommit(sha);
    await this.assertApproved(project, commit ?? null);
    return commit;
  }
}

export const publicApplicationPolicy = new PublicApplicationPolicy();
