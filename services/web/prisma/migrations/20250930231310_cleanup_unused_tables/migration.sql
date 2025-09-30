-- Drop unused tables
DROP TABLE IF EXISTS "parser_results" CASCADE;
DROP TABLE IF EXISTS "product_information" CASCADE;
DROP TABLE IF EXISTS "review_logs" CASCADE;
DROP TABLE IF EXISTS "uom_codes" CASCADE;
DROP TABLE IF EXISTS "vendors" CASCADE;

-- Remove columns from jobs that were added in rolled-back migrations
-- Keep approved and approved_at as they are now in the schema