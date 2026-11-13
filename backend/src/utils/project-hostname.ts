import { AppError } from './app-error.js';

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export const projectHostnameLabel = (id: string): string => {
  if (!uuidPattern.test(id)) throw new AppError(400, 'Project ID must be a UUID');
  return `app-${id.toLowerCase().replaceAll('-', '')}`;
};

export const localProjectUrl = (
  label: string,
  hosting: { origin: string; hostnameSuffix: string },
): string => {
  const url = new URL(hosting.origin);
  url.hostname = `${label}.${hosting.hostnameSuffix}`;
  return url.origin;
};
