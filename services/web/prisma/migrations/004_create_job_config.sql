-- Migration: Create job_config table to map batch_id to pipeline config
-- This eliminates the need for PIPELINE_CONFIG environment variable
-- Auto-cleanup via CASCADE when batch is deleted

CREATE TABLE public.job_config (
    batch_id UUID PRIMARY KEY,
    config_name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT config_name_not_empty CHECK (config_name <> '')
);

-- Add index for faster lookups
CREATE INDEX idx_job_config_created_at ON public.job_config(created_at DESC);

-- Add foreign key to temporaryStaging to cascade deletes
-- First, need to change temporaryStaging.batch_id from TEXT to UUID if needed
-- Check current type and convert if necessary
DO $$
BEGIN
    -- Check if batch_id is already UUID type
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'temporaryStaging'
        AND column_name = 'batch_id'
        AND data_type = 'text'
    ) THEN
        -- Convert TEXT to UUID
        ALTER TABLE public."temporaryStaging"
            ALTER COLUMN batch_id TYPE UUID USING batch_id::UUID;
    END IF;
END $$;

-- Now add foreign key constraint with CASCADE
ALTER TABLE public."temporaryStaging"
    ADD CONSTRAINT fk_batch_config
    FOREIGN KEY (batch_id)
    REFERENCES public.job_config(batch_id)
    ON DELETE CASCADE;

-- Similarly for tax_invoices if batch_id exists
ALTER TABLE public.tax_invoices
    ADD CONSTRAINT fk_tax_invoice_batch_config
    FOREIGN KEY (batch_id)
    REFERENCES public.job_config(batch_id)
    ON DELETE SET NULL;

COMMENT ON TABLE public.job_config IS 'Maps batch_id to pipeline configuration file. Auto-cleanup via CASCADE when batch is deleted.';
COMMENT ON COLUMN public.job_config.batch_id IS 'Unique batch identifier (UUID)';
COMMENT ON COLUMN public.job_config.config_name IS 'Pipeline configuration filename (e.g., invoice_pt_client.json)';
