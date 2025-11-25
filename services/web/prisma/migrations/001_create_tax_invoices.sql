-- Migration: Create tax_invoices table for normalized invoice headers
-- This table stores one row per unique (invoice_number, buyer_party_id)

CREATE TABLE IF NOT EXISTS public.tax_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID,
    invoice_number TEXT NOT NULL,
    buyer_party_id UUID NOT NULL REFERENCES parties(id),

    -- Invoice header fields (constants and from staging)
    tin TEXT NOT NULL DEFAULT '0021164165056000',
    tax_invoice_date DATE NOT NULL,
    tax_invoice_opt TEXT DEFAULT 'Normal',
    trx_code VARCHAR(10),
    add_info TEXT,
    custom_doc TEXT,
    custom_doc_month_year TEXT,
    ref_desc TEXT,  -- Same as invoice_number
    facility_stamp TEXT,
    seller_idtku TEXT DEFAULT '0021164165056000000000',

    -- Buyer fields (denormalized from parties for XML generation performance)
    buyer_tin TEXT,
    buyer_document TEXT DEFAULT 'TIN',
    buyer_country CHAR(3),
    buyer_document_number TEXT,
    buyer_name TEXT,
    buyer_address TEXT,
    buyer_email TEXT,
    buyer_idtku TEXT,

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Ensure unique invoice per buyer
    CONSTRAINT tax_invoices_invoice_buyer_unique UNIQUE(invoice_number, buyer_party_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tax_invoices_batch_id ON tax_invoices(batch_id);
CREATE INDEX IF NOT EXISTS idx_tax_invoices_buyer_party_id ON tax_invoices(buyer_party_id);
CREATE INDEX IF NOT EXISTS idx_tax_invoices_invoice_number ON tax_invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_tax_invoices_date ON tax_invoices(tax_invoice_date);

-- Comments for documentation
COMMENT ON TABLE tax_invoices IS 'Normalized invoice headers, one row per (invoice_number, buyer_party_id)';
COMMENT ON COLUMN tax_invoices.tin IS 'Seller TIN (constant: 0021164165056000)';
COMMENT ON COLUMN tax_invoices.seller_idtku IS 'Seller IDTKU (constant: 0021164165056000000000)';
COMMENT ON COLUMN tax_invoices.ref_desc IS 'Reference description (same as invoice_number)';
