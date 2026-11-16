import { AppError } from './app-error.js';

export const PUBLIC_COMMIT_PATTERN = /^[a-f0-9]{40}$/i;

export const parseGitBranch = (value: unknown): string => {
  if (typeof value !== 'string') throw new AppError(400, 'Repository branch is required');

  const branch = value.trim();
  if (
    branch.length > 255 || !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.includes('..') || branch.split('/').some((segment) =>
      segment.length === 0 || segment.startsWith('.') || segment.endsWith('.') || segment.endsWith('.lock'))
  ) {
    throw new AppError(400, 'Repository branch is invalid');
  }
  return branch;
};

export const parsePublicCommit = (value: unknown): string => {
  if (typeof value !== 'string' || !PUBLIC_COMMIT_PATTERN.test(value)) {
    throw new AppError(400, 'A full 40-character Git commit SHA is required');
  }
  return value.toLowerCase();
};
