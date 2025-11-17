-- Revamp HS codes schema to align with new Barang/Jasa datasets

-- Drop legacy table (CASCADE will handle all indexes and constraints)
DROP TABLE IF EXISTS "hs_codes" CASCADE;

-- Recreate enum for HS code type when needed
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hs_code_type') THEN
    CREATE TYPE "hs_code_type" AS ENUM ('BARANG', 'JASA');
  END IF;
END
$$;

-- Replace hs_codes table with new normalized shape
CREATE TABLE "hs_codes" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" VARCHAR(6) NOT NULL,
  "type" "hs_code_type" NOT NULL,
  "level" "hs_level" NOT NULL,
  "section_code" CHAR(2) NOT NULL,
  "chapter_code" CHAR(2) NOT NULL,
  "group_code" CHAR(2) NOT NULL,
  "description_en" TEXT NOT NULL,
  "description_id" TEXT NOT NULL,
  "parent_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now()
);

ALTER TABLE "hs_codes"
  ADD CONSTRAINT "hs_codes_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "hs_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "hs_codes_code_type_key" ON "hs_codes"("code", "type");
CREATE INDEX "idx_hs_codes_code" ON "hs_codes"("code");
CREATE INDEX "idx_hs_codes_code_pattern" ON "hs_codes" USING btree (("code") text_pattern_ops);
CREATE INDEX "idx_hs_codes_type_level" ON "hs_codes"("type", "level");
CREATE INDEX "idx_hs_codes_parent" ON "hs_codes"("parent_id");
