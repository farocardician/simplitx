-- Add job_id column (nullable for backward compatibility)
ALTER TABLE parser_results
ADD COLUMN IF NOT EXISTS job_id TEXT;

-- Create index for query performance
CREATE INDEX IF NOT EXISTS idx_parser_results_job_id
ON parser_results(job_id);

-- Note: No FK constraint in MVP to keep it simple