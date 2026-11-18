import type { RequestHandler } from 'express';

import { broadcastDeploymentEvent } from '../realtime/deployment-socket.js';
import { deploymentService } from '../services/deployment.service.js';
import { getPublicDeploymentHosting } from '../services/project.service.js';
import { getAuthenticatedUserId } from '../utils/auth-request.js';
import { parseDeploymentCommit } from '../utils/project-validation.js';

export const deployProject: RequestHandler = async (request, response) => {
  const userId = getAuthenticatedUserId(request);
  const deployment = await deploymentService.deployProjectForUser(
    userId,
    request.params.id,
    broadcastDeploymentEvent,
    parseDeploymentCommit(request.body),
  );

  response.status(201).json({ deployment, ...await getPublicDeploymentHosting(userId, deployment.projectId) });
};

export const listProjectDeployments: RequestHandler = async (
  request,
  response,
) => {
  const deployments = await deploymentService.listProjectDeployments(
    getAuthenticatedUserId(request),
    request.params.id,
  );

  response.status(200).json({ deployments });
};

export const getDeployment: RequestHandler = async (request, response) => {
  const deployment = await deploymentService.getDeploymentForUser(
    getAuthenticatedUserId(request),
    request.params.id,
  );

  response.status(200).json({ deployment });
};

export const stopDeployment: RequestHandler = async (request, response) => {
  const userId = getAuthenticatedUserId(request);
  const deployment = await deploymentService.stopDeployment(
    userId,
    request.params.id,
    broadcastDeploymentEvent,
  );

  response.status(200).json({ deployment, ...await getPublicDeploymentHosting(userId, deployment.projectId) });
};

export const restartDeployment: RequestHandler = async (request, response) => {
  const userId = getAuthenticatedUserId(request);
  const deployment = await deploymentService.restartDeployment(
    userId,
    request.params.id,
    broadcastDeploymentEvent,
  );

  response.status(200).json({ deployment, ...await getPublicDeploymentHosting(userId, deployment.projectId) });
};

export const redeployDeployment: RequestHandler = async (request, response) => {
  const userId = getAuthenticatedUserId(request);
  const deployment = await deploymentService.redeployDeployment(
    userId,
    request.params.id,
    broadcastDeploymentEvent,
    parseDeploymentCommit(request.body),
  );

  response.status(201).json({ deployment, ...await getPublicDeploymentHosting(userId, deployment.projectId) });
};

export const rollbackDeployment: RequestHandler = async (request, response) => {
  const userId = getAuthenticatedUserId(request);
  const deployment = await deploymentService.rollbackDeployment(
    userId,
    request.params.id,
    broadcastDeploymentEvent,
  );

  response.status(201).json({ deployment, ...await getPublicDeploymentHosting(userId, deployment.projectId) });
};

export const getDeploymentLogs: RequestHandler = async (request, response) => {
  const logs = await deploymentService.getDeploymentLogs(
    getAuthenticatedUserId(request),
    request.params.id,
  );

  response.status(200).json({ logs });
};

export const getDeploymentMetrics: RequestHandler = async (
  request,
  response,
) => {
  const metrics = await deploymentService.getDeploymentMetrics(
    getAuthenticatedUserId(request),
    request.params.id,
  );

  response.status(200).json({ metrics });
};
