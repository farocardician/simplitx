-- Migration: Create tax_invoice_items table for invoice line items
-- This table stores one row per line item (GoodService) in each invoice

CREATE TABLE IF NOT EXISTS public.tax_invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tax_invoice_id UUID NOT NULL REFERENCES tax_invoices(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,

    -- Item identification fields
    opt CHAR(1),  -- A or B, extracted from hs_code letter prefix
    code CHAR(6) NOT NULL,  -- 6-digit HS code (validated against hs_codes table)
    name TEXT NOT NULL,  -- Item description
    unit TEXT NOT NULL,  -- UOM code (e.g., UM.0003 for KG)

    -- Pricing fields
    price NUMERIC NOT NULL,  -- Unit price
    qty NUMERIC NOT NULL,  -- Quantity in base UOM

    -- Computed tax fields
    total_discount NUMERIC DEFAULT 0,
    tax_base NUMERIC NOT NULL,  -- price * qty
    other_tax_base NUMERIC NOT NULL,  -- (11/12) * tax_base
    vat_rate NUMERIC DEFAULT 12,  -- Always 12%
    vat NUMERIC NOT NULL,  -- (12/100) * other_tax_base
    stlg_rate NUMERIC DEFAULT 0,  -- Optional luxury tax rate
    stlg NUMERIC DEFAULT 0,  -- Optional luxury tax amount

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Ensure unique line numbers per invoice
    CONSTRAINT tax_invoice_items_invoice_line_unique UNIQUE(tax_invoice_id, line_number)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tax_invoice_items_invoice_id ON tax_invoice_items(tax_invoice_id);
CREATE INDEX IF NOT EXISTS idx_tax_invoice_items_code ON tax_invoice_items(code);

-- Comments for documentation
COMMENT ON TABLE tax_invoice_items IS 'Invoice line items (GoodService), many rows per invoice';
COMMENT ON COLUMN tax_invoice_items.opt IS 'Option A or B from HS code letter prefix';
COMMENT ON COLUMN tax_invoice_items.code IS '6-digit HS code validated against public.hs_codes';
COMMENT ON COLUMN tax_invoice_items.unit IS 'UOM code resolved from uom_aliases (e.g., UM.0003)';
COMMENT ON COLUMN tax_invoice_items.tax_base IS 'Calculated as price * qty';
COMMENT ON COLUMN tax_invoice_items.other_tax_base IS 'Calculated as (11/12) * tax_base';
COMMENT ON COLUMN tax_invoice_items.vat IS 'Calculated as (12/100) * other_tax_base';
