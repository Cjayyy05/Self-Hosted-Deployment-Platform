ALTER TABLE "PublicRoutingBinding"
    ADD COLUMN "routeGeneration" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "routeRecoveryRequired" BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT "PublicRoutingBinding_generation_nonnegative" CHECK ("routeGeneration" >= 0);
