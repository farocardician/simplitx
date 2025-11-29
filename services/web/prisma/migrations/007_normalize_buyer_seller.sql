-- Migration: Normalize buyer/seller data by removing duplicated columns from tax_invoices
-- - Buyer details now come exclusively from public.parties via buyer_party_id
-- - Seller is resolved via job_config.seller_id -> public.parties

-- 1) Extend parties with seller metadata
ALTER TABLE public.parties
    ADD COLUMN IF NOT EXISTS seller_idtku TEXT,
    ADD COLUMN IF NOT EXISTS tax_invoice_opt TEXT;

COMMENT ON COLUMN public.parties.seller_idtku IS 'Seller IDTKU used for XML generation';
COMMENT ON COLUMN public.parties.tax_invoice_opt IS 'Seller tax invoice option used for XML generation';

-- 2) Add seller_id to job_config to point at the seller party
ALTER TABLE public.job_config
    ADD COLUMN IF NOT EXISTS seller_id UUID REFERENCES public.parties(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.job_config.seller_id IS 'Seller party for this job/config (used to derive seller metadata)';

-- 3) Drop duplicated buyer/seller columns from tax_invoices
ALTER TABLE public.tax_invoices
    DROP COLUMN IF EXISTS tin,
    DROP COLUMN IF EXISTS seller_idtku,
    DROP COLUMN IF EXISTS trx_code,
    DROP COLUMN IF EXISTS buyer_tin,
    DROP COLUMN IF EXISTS buyer_document,
    DROP COLUMN IF EXISTS buyer_country,
    DROP COLUMN IF EXISTS buyer_document_number,
    DROP COLUMN IF EXISTS buyer_name,
    DROP COLUMN IF EXISTS buyer_address,
    DROP COLUMN IF EXISTS buyer_email,
    DROP COLUMN IF EXISTS buyer_idtku;

-- Ensure completeness columns exist for the enriched view
ALTER TABLE public.tax_invoices
    ADD COLUMN IF NOT EXISTS is_complete boolean,
    ADD COLUMN IF NOT EXISTS missing_fields jsonb;

-- 4) Create an enriched view to expose the derived fields for reads
CREATE OR REPLACE VIEW public.tax_invoices_enriched AS
SELECT
    ti.id,
    ti.job_id,
    ti.invoice_number,
    ti.buyer_party_id,
    ti.tax_invoice_date,
    ti.tax_invoice_opt,
    ti.add_info,
    ti.custom_doc,
    ti.custom_doc_month_year,
    ti.ref_desc,
    ti.facility_stamp,
    ti.is_complete,
    ti.missing_fields,
    ti.created_at,
    ti.updated_at,
    buyer.transaction_code AS trx_code,
    buyer.tin_normalized AS buyer_tin,
    buyer.buyer_document AS buyer_document,
    buyer.country_code AS buyer_country,
    buyer.buyer_document_number AS buyer_document_number,
    buyer.display_name AS buyer_name,
    buyer.address_full AS buyer_address,
    buyer.email AS buyer_email,
    buyer.buyer_idtku AS buyer_idtku,
    seller.tin_normalized AS tin,
    seller.seller_idtku AS seller_idtku,
    jc.config_name AS config_name,
    jc.seller_id AS seller_id
FROM public.tax_invoices ti
LEFT JOIN public.job_config jc ON ti.job_id = jc.job_id
LEFT JOIN public.parties buyer ON ti.buyer_party_id = buyer.id
LEFT JOIN public.parties seller ON jc.seller_id = seller.id;

COMMENT ON VIEW public.tax_invoices_enriched IS 'Read-only projection of tax_invoices joined with buyer/seller parties';
