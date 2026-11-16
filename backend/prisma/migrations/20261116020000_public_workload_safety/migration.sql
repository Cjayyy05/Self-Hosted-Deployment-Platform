BEGIN;

ALTER TABLE "PublicRoutingBinding" ADD COLUMN "nextWorkloadAddress" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "ingressSocketPath" TEXT NOT NULL DEFAULT '/run/deployflow-ingress/auth.sock',
    ADD CONSTRAINT "PublicRoutingBinding_address_range" CHECK ("nextWorkloadAddress" BETWEEN 0 AND 4194303);
ALTER TABLE "Deployment" ADD COLUMN "publicAddressIndex" INTEGER,
    ADD COLUMN "buildNetworkId" TEXT,
    ADD COLUMN "guardedBuild" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "buildHostBootId" UUID,
    ADD COLUMN "buildEndedAt" TIMESTAMP(3),
    ADD CONSTRAINT "Deployment_public_address_range" CHECK ("publicAddressIndex" BETWEEN 1 AND 4194303),
    ADD CONSTRAINT "Deployment_build_network_id" CHECK ("buildNetworkId" ~ '^[a-f0-9]{64}$');
CREATE UNIQUE INDEX "Deployment_publicAddressIndex_key" ON "Deployment" ("publicAddressIndex");
CREATE UNIQUE INDEX "Deployment_buildNetworkId_key" ON "Deployment" ("buildNetworkId");

COMMIT;
