import { randomUUID } from 'node:crypto';

import { database } from '../config/database.js';
import { AppError } from '../utils/app-error.js';

const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1_000;
const DEFAULT_RENEWAL_INTERVAL_MS = 60 * 1_000;

type LockUpdateResult = { count: number };

export type ProjectOperationLockDatabase = {
  project: {
    updateMany: (options: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<LockUpdateResult>;
  };
};

export type ProjectOperationLock = {
  runExclusive: <T>(
    projectId: string,
    operation: (lease?: ProjectOperationLease) => Promise<T>,
  ) => Promise<T>;
};

export type ProjectOperationLease = {
  token: string;
  assertValid: () => Promise<void>;
};

type ProjectOperationLockDependencies = {
  database?: ProjectOperationLockDatabase;
  now?: () => Date;
  createToken?: () => string;
  leaseDurationMs?: number;
  renewalIntervalMs?: number;
};

export class ProjectOperationLockService implements ProjectOperationLock {
  readonly #database: ProjectOperationLockDatabase;
  readonly #now: () => Date;
  readonly #createToken: () => string;
  readonly #leaseDurationMs: number;
  readonly #renewalIntervalMs: number;
  readonly #active = new Set<string>();

  public constructor(dependencies: ProjectOperationLockDependencies = {}) {
    this.#database = dependencies.database ?? database;
    this.#now = dependencies.now ?? (() => new Date());
    this.#createToken = dependencies.createToken ?? randomUUID;
    this.#leaseDurationMs =
      dependencies.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.#renewalIntervalMs =
      dependencies.renewalIntervalMs ?? DEFAULT_RENEWAL_INTERVAL_MS;
  }

  public async runExclusive<T>(
    projectId: string,
    operation: (lease?: ProjectOperationLease) => Promise<T>,
  ): Promise<T> {
    const token = this.#createToken();
    if (this.#active.has(projectId)) {
      throw new AppError(
        409,
        'Another deployment operation is already active for this project',
      );
    }
    this.#active.add(projectId);
    try {
      if (!await this.#acquire(projectId, token)) {
        throw new AppError(409, 'Another deployment operation is already active for this project');
      }
      return await this.#runHeld(projectId, token, operation);
    } finally {
      this.#active.delete(projectId);
    }
  }

  async #runHeld<T>(
    projectId: string,
    token: string,
    operation: (lease?: ProjectOperationLease) => Promise<T>,
  ): Promise<T> {
    let renewalInProgress = false;
    const renewalTimer = setInterval(() => {
      if (renewalInProgress) return;
      renewalInProgress = true;
      void this.#renew(projectId, token).finally(() => {
        renewalInProgress = false;
      });
    }, this.#renewalIntervalMs);
    renewalTimer.unref();

    try {
      return await operation({
        token,
        assertValid: async () => {
          if (!await this.#renew(projectId, token)) {
            throw new AppError(409, 'Project operation lease could not be verified');
          }
        },
      });
    } finally {
      clearInterval(renewalTimer);
      await this.#release(projectId, token);
    }
  }

  async #acquire(projectId: string, token: string): Promise<boolean> {
    const now = this.#now();

    try {
      const result = await this.#database.project.updateMany({
        where: {
          id: projectId,
          OR: [
            { operationLockToken: null },
            { operationLockExpiresAt: null },
            { operationLockExpiresAt: { lte: now } },
          ],
        },
        data: {
          operationLockToken: token,
          operationLockExpiresAt: new Date(
            now.getTime() + this.#leaseDurationMs,
          ),
        },
      });
      return result.count === 1;
    } catch {
      throw new AppError(503, 'Unable to acquire the project operation lock');
    }
  }

  async #renew(projectId: string, token: string): Promise<boolean> {
    const now = this.#now();

    try {
      const result = await this.#database.project.updateMany({
        where: { id: projectId, operationLockToken: token, operationLockExpiresAt: { gt: now } },
        data: {
          operationLockExpiresAt: new Date(
            now.getTime() + this.#leaseDurationMs,
          ),
        },
      });
      return result.count === 1;
    } catch {
      return false;
    }
  }

  async #release(projectId: string, token: string): Promise<void> {
    try {
      await this.#database.project.updateMany({
        where: { id: projectId, operationLockToken: token },
        data: { operationLockToken: null, operationLockExpiresAt: null },
      });
    } catch {
      // A failed release cannot become permanent because the lease expires.
    }
  }
}

export const projectOperationLockService =
  new ProjectOperationLockService();
