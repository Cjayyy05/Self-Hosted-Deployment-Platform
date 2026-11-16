BEGIN;

ALTER TABLE "ProjectPublicApproval" ADD COLUMN "withdrawnAt" TIMESTAMP(3),
    ADD CONSTRAINT "ProjectPublicApproval_withdrawn_requires_revocation"
      CHECK ("withdrawnAt" IS NULL OR ("revokedAt" IS NOT NULL AND "withdrawnAt" >= "revokedAt"));

CREATE TABLE "PublicRoutingBinding" (
    "id" INTEGER PRIMARY KEY CHECK ("id" = 1),
    "projectId" UUID,
    "hostnameSuffix" TEXT NOT NULL,
    "adminSocketPath" TEXT NOT NULL
);

COMMIT;
