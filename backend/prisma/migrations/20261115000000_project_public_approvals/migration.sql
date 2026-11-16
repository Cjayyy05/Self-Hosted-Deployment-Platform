BEGIN;

CREATE TABLE "ProjectPublicApproval" (
    "projectId" UUID PRIMARY KEY REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "repositoryUrl" TEXT NOT NULL,
    "branch" VARCHAR(255) NOT NULL,
    "approvedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3)
);

CREATE TABLE "ProjectPublicRevision" (
    "projectId" UUID NOT NULL REFERENCES "ProjectPublicApproval"("projectId") ON DELETE CASCADE ON UPDATE CASCADE,
    "commitHash" VARCHAR(40) NOT NULL CHECK ("commitHash" ~ '^[0-9a-f]{40}$'),
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    PRIMARY KEY ("projectId", "commitHash")
);

COMMIT;
