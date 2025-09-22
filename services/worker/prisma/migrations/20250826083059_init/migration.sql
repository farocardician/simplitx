-- CreateEnum
CREATE TYPE "public"."job_status" AS ENUM ('uploaded', 'queued', 'processing', 'complete', 'failed');

-- CreateTable
CREATE TABLE "public"."jobs" (
    "id" TEXT NOT NULL,
    "owner_session_id" TEXT,
    "user_id" TEXT,
    "original_filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL DEFAULT 'application/pdf',
    "bytes" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "mapping" TEXT NOT NULL DEFAULT 'pt_simon_invoice_v1',
    "status" "public"."job_status" NOT NULL DEFAULT 'uploaded',
    "upload_path" TEXT,
    "result_path" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "queued_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "leased_by" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "first_downloaded_at" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "jobs_status_created_at_idx" ON "public"."jobs"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "jobs_owner_session_id_status_idx" ON "public"."jobs"("owner_session_id", "status");

-- CreateIndex
CREATE INDEX "jobs_owner_session_id_created_at_idx" ON "public"."jobs"("owner_session_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "jobs_lease_expires_at_idx" ON "public"."jobs"("lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_owner_session_id_sha256_mapping_bytes_key" ON "public"."jobs"("owner_session_id", "sha256", "mapping", "bytes");
