-- Migration: Rename batch_id to job_id in job_config and temporaryStaging
-- This completes the transition from batch_id to job_id across all tables

-- Step 1: Drop foreign key constraints that reference batch_id
ALTER TABLE public."temporaryStaging"
    DROP CONSTRAINT IF EXISTS fk_batch_config;

ALTER TABLE public.tax_invoices
    DROP CONSTRAINT IF EXISTS fk_tax_invoice_job_config;

-- Step 2: Rename job_config.batch_id to job_id
ALTER TABLE public.job_config
    RENAME COLUMN batch_id TO job_id;

-- Step 3: Rename temporaryStaging.batch_id to job_id
ALTER TABLE public."temporaryStaging"
    RENAME COLUMN batch_id TO job_id;

-- Step 4: Rename indexes
ALTER INDEX IF EXISTS idx_temporary_staging_batch_id RENAME TO idx_temporary_staging_job_id;

-- Step 5: Recreate foreign key constraints with new column names
ALTER TABLE public."temporaryStaging"
    ADD CONSTRAINT fk_job_config
    FOREIGN KEY (job_id)
    REFERENCES public.job_config(job_id)
    ON DELETE CASCADE;

ALTER TABLE public.tax_invoices
    ADD CONSTRAINT fk_tax_invoice_job_config
    FOREIGN KEY (job_id)
    REFERENCES public.job_config(job_id)
    ON DELETE SET NULL;

-- Step 6: Update comments
COMMENT ON COLUMN public.job_config.job_id IS 'Unique job identifier (UUID) - identifies an import job and its associated config';
COMMENT ON COLUMN public."temporaryStaging".job_id IS 'Reference to job_config.job_id - identifies which import job created this staging row';
COMMENT ON TABLE public.job_config IS 'Maps job_id to pipeline configuration file. Auto-cleanup via CASCADE when job is deleted.';
