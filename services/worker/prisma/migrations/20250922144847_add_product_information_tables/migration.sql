-- AlterTable
ALTER TABLE "public"."jobs" ADD COLUMN     "approved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "artifact_path" TEXT;

-- CreateTable
CREATE TABLE "public"."vendors" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."uom_codes" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "uom_codes_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "public"."product_information" (
    "id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "sku" TEXT,
    "description" TEXT NOT NULL,
    "uom_code" TEXT NOT NULL,
    "opt_code" TEXT NOT NULL,
    "hs_code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_information_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendors_name_key" ON "public"."vendors"("name");

-- CreateIndex
CREATE INDEX "product_information_vendor_id_idx" ON "public"."product_information"("vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_information_vendor_id_sku_key" ON "public"."product_information"("vendor_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "product_information_vendor_id_description_key" ON "public"."product_information"("vendor_id", "description");

-- AddForeignKey
ALTER TABLE "public"."product_information" ADD CONSTRAINT "product_information_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."product_information" ADD CONSTRAINT "product_information_uom_code_fkey" FOREIGN KEY ("uom_code") REFERENCES "public"."uom_codes"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
