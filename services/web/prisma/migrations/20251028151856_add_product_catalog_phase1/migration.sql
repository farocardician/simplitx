-- CreateEnum
CREATE TYPE "public"."product_status" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "public"."product_alias_status" AS ENUM ('active', 'draft');

-- CreateEnum
CREATE TYPE "public"."product_draft_kind" AS ENUM ('new_product', 'alias');

-- CreateEnum
CREATE TYPE "public"."product_draft_status" AS ENUM ('draft', 'approved', 'rejected');

-- AlterTable
ALTER TABLE "public"."jobs" ADD COLUMN     "approved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "artifact_path" TEXT,
ADD COLUMN     "buyer_party_id" UUID,
ADD COLUMN     "buyer_resolution_confidence" DOUBLE PRECISION,
ADD COLUMN     "buyer_resolution_decided_at" TIMESTAMP(3),
ADD COLUMN     "buyer_resolution_status" TEXT;

-- CreateTable
CREATE TABLE "public"."parser_results" (
    "doc_id" TEXT NOT NULL,
    "final" JSONB NOT NULL,
    "manifest" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parser_results_pkey" PRIMARY KEY ("doc_id")
);

-- CreateTable
CREATE TABLE "public"."unit_of_measures" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "unit_of_measures_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "public"."uom_aliases" (
    "alias" TEXT NOT NULL,
    "uom_code" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uom_aliases_pkey" PRIMARY KEY ("alias")
);

-- CreateTable
CREATE TABLE "public"."parties" (
    "id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "name_normalized" TEXT NOT NULL,
    "tin_display" TEXT NOT NULL,
    "tin_normalized" TEXT NOT NULL,
    "country_code" CHAR(3),
    "transaction_code" VARCHAR(10),
    "address_full" TEXT,
    "email" TEXT,
    "buyer_document" VARCHAR(50) DEFAULT 'TIN',
    "buyer_document_number" VARCHAR(100),
    "buyer_idtku" VARCHAR(100),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."transaction_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."products" (
    "id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "hs_code" VARCHAR(6),
    "type" "public"."hs_code_type",
    "uom_code" TEXT,
    "status" "public"."product_status" NOT NULL DEFAULT 'active',
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."product_aliases" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "alias_description" TEXT NOT NULL,
    "status" "public"."product_alias_status" NOT NULL DEFAULT 'draft',
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "product_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."product_drafts" (
    "id" UUID NOT NULL,
    "kind" "public"."product_draft_kind" NOT NULL,
    "description" TEXT,
    "hs_code" VARCHAR(6),
    "type" "public"."hs_code_type",
    "uom_code" TEXT,
    "target_product_id" UUID,
    "alias_description" TEXT,
    "source_invoice_id" TEXT,
    "source_pdf_line_text" TEXT,
    "confidence_score" DOUBLE PRECISION,
    "status" "public"."product_draft_status" NOT NULL DEFAULT 'draft',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "product_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."enrichment_events" (
    "id" UUID NOT NULL,
    "invoice_id" TEXT,
    "line_item_index" INTEGER,
    "input_description" TEXT NOT NULL,
    "matched_product_id" UUID,
    "match_score" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION NOT NULL,
    "auto_filled" BOOLEAN NOT NULL,
    "enriched_hs_code" VARCHAR(6),
    "enriched_type" "public"."hs_code_type",
    "enriched_uom_code" TEXT,
    "draft_created" BOOLEAN NOT NULL DEFAULT false,
    "draft_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "enrichment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "uom_aliases_uom_code_idx" ON "public"."uom_aliases"("uom_code");

-- CreateIndex
CREATE INDEX "idx_parties_deleted_at" ON "public"."parties"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_codes_code_key" ON "public"."transaction_codes"("code");

-- CreateIndex
CREATE INDEX "transaction_codes_code_idx" ON "public"."transaction_codes"("code");

-- CreateIndex
CREATE INDEX "products_status_idx" ON "public"."products"("status");

-- CreateIndex
CREATE INDEX "products_deleted_at_idx" ON "public"."products"("deleted_at");

-- CreateIndex
CREATE INDEX "product_aliases_product_id_idx" ON "public"."product_aliases"("product_id");

-- CreateIndex
CREATE INDEX "product_aliases_status_idx" ON "public"."product_aliases"("status");

-- CreateIndex
CREATE INDEX "product_aliases_deleted_at_idx" ON "public"."product_aliases"("deleted_at");

-- CreateIndex
CREATE INDEX "product_drafts_status_idx" ON "public"."product_drafts"("status");

-- CreateIndex
CREATE INDEX "product_drafts_kind_idx" ON "public"."product_drafts"("kind");

-- CreateIndex
CREATE INDEX "product_drafts_created_at_idx" ON "public"."product_drafts"("created_at");

-- CreateIndex
CREATE INDEX "enrichment_events_invoice_id_idx" ON "public"."enrichment_events"("invoice_id");

-- CreateIndex
CREATE INDEX "enrichment_events_matched_product_id_idx" ON "public"."enrichment_events"("matched_product_id");

-- CreateIndex
CREATE INDEX "enrichment_events_created_at_idx" ON "public"."enrichment_events"("created_at");

-- CreateIndex

-- AddForeignKey
ALTER TABLE "public"."uom_aliases" ADD CONSTRAINT "uom_aliases_uom_code_fkey" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measures"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."products" ADD CONSTRAINT "products_uom_code_fkey" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measures"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."product_aliases" ADD CONSTRAINT "product_aliases_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
