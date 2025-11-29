-- Migration: Rename tax_invoices.batch_id to job_id for clarity
-- This better reflects that invoices are created from a specific job

-- Rename the column
ALTER TABLE public.tax_invoices
    RENAME COLUMN batch_id TO job_id;

-- Rename the index
ALTER INDEX idx_tax_invoices_batch_id RENAME TO idx_tax_invoices_job_id;

-- Drop old foreign key constraint
ALTER TABLE public.tax_invoices
    DROP CONSTRAINT IF EXISTS fk_tax_invoice_batch_config;

-- Add new foreign key constraint with updated name
ALTER TABLE public.tax_invoices
    ADD CONSTRAINT fk_tax_invoice_job_config
    FOREIGN KEY (job_id)
    REFERENCES public.job_config(batch_id)
    ON DELETE SET NULL;

COMMENT ON COLUMN public.tax_invoices.job_id IS 'Reference to job_config.batch_id - identifies which import job created this invoice';
