BEGIN;

ALTER TABLE "Project" ADD COLUMN "hostnameLabel" VARCHAR(36);

UPDATE "Project"
SET "hostnameLabel" = 'app-' || replace("id"::text, '-', '');

ALTER TABLE "Project"
    ALTER COLUMN "hostnameLabel" SET NOT NULL,
    ADD CONSTRAINT "Project_hostnameLabel_matches_id"
        CHECK ("hostnameLabel" = 'app-' || replace("id"::text, '-', ''));

CREATE UNIQUE INDEX "Project_hostnameLabel_key" ON "Project"("hostnameLabel");

COMMIT;
