import type { RequestHandler } from 'express';

import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProjectHealthCheck,
} from '../services/project.service.js';
import { getAuthenticatedUserId } from '../utils/auth-request.js';
import { approveProjectRevision, getProjectApproval, revokeProjectApproval } from '../services/project-approval.service.js';
import {
  parseApprovalInput,
  parseProjectId,
  parseProjectHealthCheckInput,
  parseProjectInput,
} from '../utils/project-validation.js';

export const getApproval: RequestHandler = async (request, response) => {
  const approval = await getProjectApproval(getAuthenticatedUserId(request), parseProjectId(request.params.id));
  response.json({ approval });
};

export const approveRevision: RequestHandler = async (request, response) => {
  const approval = await approveProjectRevision(
    getAuthenticatedUserId(request), parseProjectId(request.params.id), parseApprovalInput(request.body),
  );
  response.json({ approval });
};

export const revokeApproval: RequestHandler = async (request, response) => {
  const approval = await revokeProjectApproval(getAuthenticatedUserId(request), parseProjectId(request.params.id));
  response.status(approval.status === 'WITHDRAWAL_PENDING' ? 202 : 200).json({ approval });
};

export const create: RequestHandler = async (request, response) => {
  const userId = getAuthenticatedUserId(request);
  const input = parseProjectInput(request.body);
  const project = await createProject(userId, input);

  response.status(201).json({ project });
};

export const list: RequestHandler = async (request, response) => {
  const projects = await listProjects(getAuthenticatedUserId(request));

  response.status(200).json({ projects });
};

export const getById: RequestHandler = async (request, response) => {
  const project = await getProject(
    getAuthenticatedUserId(request),
    parseProjectId(request.params.id),
  );

  response.status(200).json({ project });
};

export const updateHealthCheck: RequestHandler = async (request, response) => {
  const userId = getAuthenticatedUserId(request);
  const projectId = parseProjectId(request.params.id);
  const { healthCheckPath } = parseProjectHealthCheckInput(request.body);
  const project = await updateProjectHealthCheck(
    userId,
    projectId,
    healthCheckPath,
  );

  response.status(200).json({ project });
};

export const remove: RequestHandler = async (request, response) => {
  await deleteProject(
    getAuthenticatedUserId(request),
    parseProjectId(request.params.id),
  );

  response.sendStatus(204);
};
