-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'party_type') THEN
    CREATE TYPE "public"."party_type" AS ENUM ('seller', 'buyer');
  END IF;
END$$;

-- AlterTable
ALTER TABLE "public"."parties"
ADD COLUMN IF NOT EXISTS "party_type" "public"."party_type" NOT NULL DEFAULT 'buyer',
ADD COLUMN IF NOT EXISTS "seller_id" UUID;

-- Add check constraint to ensure only buyers can reference sellers
ALTER TABLE "public"."parties"
DROP CONSTRAINT IF EXISTS "chk_parties_seller_link_when_buyer";

ALTER TABLE "public"."parties"
ADD CONSTRAINT "chk_parties_seller_link_when_buyer"
CHECK ("party_type" = 'buyer' OR "seller_id" IS NULL);

-- Add FK constraint for seller linkage
ALTER TABLE "public"."parties"
DROP CONSTRAINT IF EXISTS "parties_seller_id_fkey";

ALTER TABLE "public"."parties"
ADD CONSTRAINT "parties_seller_id_fkey"
FOREIGN KEY ("seller_id") REFERENCES "public"."parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes
CREATE INDEX IF NOT EXISTS "idx_parties_party_type"
ON "public"."parties"("party_type")
WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_parties_seller_id"
ON "public"."parties"("seller_id")
WHERE "deleted_at" IS NULL;
