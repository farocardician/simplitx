-- Migration: Remove hardcoded seller defaults from tax_invoices table
-- Values must now come from configuration, not database defaults

ALTER TABLE public.tax_invoices
    ALTER COLUMN tin DROP DEFAULT,
    ALTER COLUMN seller_idtku DROP DEFAULT,
    ALTER COLUMN tax_invoice_opt DROP DEFAULT;

-- Update documentation to reflect config-driven approach
COMMENT ON COLUMN tax_invoices.tin IS 'Seller TIN (from parties table via seller.id in pipeline config)';
COMMENT ON COLUMN tax_invoices.seller_idtku IS 'Seller IDTKU (from parties table via seller.id in pipeline config)';
COMMENT ON COLUMN tax_invoices.tax_invoice_opt IS 'Tax invoice option (from seller.tax_invoice_opt in pipeline config)';
