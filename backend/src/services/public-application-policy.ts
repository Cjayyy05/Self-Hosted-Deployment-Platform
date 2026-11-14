import type { PublicApplication } from '../config/env.js';
import { AppError } from '../utils/app-error.js';

export const assertApprovedSource = (
  approved: PublicApplication | undefined,
  source: { repositoryUrl: string; branch: string; id?: string },
): void => {
  if (approved !== undefined && (source.repositoryUrl.toLowerCase() !== approved.repositoryUrl.toLowerCase() ||
    source.branch !== approved.branch || (source.id !== undefined && source.id !== approved.projectId))) {
    throw new AppError(403, 'This project or repository is outside the approved public hosting configuration');
  }
};

export const assertApprovedCommit = (approved: PublicApplication | undefined, commit: string | null): void => {
  if (approved !== undefined && (commit === null || !approved.commits.has(commit))) {
    throw new AppError(403, 'This Git revision has not been approved for public hosting');
  }
};
