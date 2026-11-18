BEGIN;

CREATE TYPE "RoutingOperation" AS ENUM ('PROMOTE', 'ABORT', 'RETIRE', 'STOP', 'RESTART', 'DELETE');

ALTER TABLE "Project"
    ADD COLUMN "activeDeploymentId" UUID,
    ADD COLUMN "routingOperation" "RoutingOperation",
    ADD COLUMN "routingDeploymentId" UUID,
    ADD CONSTRAINT "Project_routing_operation_target"
        CHECK (("routingOperation" IS NULL) = ("routingDeploymentId" IS NULL));

CREATE UNIQUE INDEX "Deployment_projectId_id_key" ON "Deployment"("projectId", "id");

ALTER TABLE "Project"
    ADD CONSTRAINT "Project_id_activeDeploymentId_fkey"
        FOREIGN KEY ("id", "activeDeploymentId") REFERENCES "Deployment"("projectId", "id")
        ON DELETE NO ACTION ON UPDATE NO ACTION,
    ADD CONSTRAINT "Project_id_routingDeploymentId_fkey"
        FOREIGN KEY ("id", "routingDeploymentId") REFERENCES "Deployment"("projectId", "id")
        ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT;
