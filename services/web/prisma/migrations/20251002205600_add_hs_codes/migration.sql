-- HS Code Taxonomy Schema
-- Best-practice schema for HS2/HS4/HS6 codes with fast lookup, text search, and LLM readiness
-- Idempotent: can be run multiple times safely

-- ============================================================================
-- PART 1: EXTENSIONS
-- ============================================================================

-- Enable pg_trgm for trigram fuzzy search (fallback for typos)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Enable pgcrypto for gen_random_uuid() function
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enable unaccent for accent-insensitive search
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Optional: Enable pgvector for embeddings (comment out if not available)
-- CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- PART 2: ENUM TYPES
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE hs_level AS ENUM ('HS2', 'HS4', 'HS6');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- PART 3: MAIN TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS hs_codes (
  -- Primary key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Core fields
  code VARCHAR(6) NOT NULL,
  level hs_level NOT NULL,
  jurisdiction VARCHAR(10) NOT NULL DEFAULT 'ID',
  version_year INTEGER NOT NULL DEFAULT 2022,

  -- Hierarchy (self-reference to parent)
  parent_code VARCHAR(6),

  -- Descriptions
  description_en TEXT NOT NULL,
  description_id TEXT NOT NULL,
  notes TEXT,

  -- Optional: Embeddings for LLM use (uncomment if pgvector is enabled)
  -- embedding vector,

  -- Generated search vectors (auto-maintained by PostgreSQL)
  -- Using unaccent + lower for better recall across languages
  search_vector_en tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', unaccent(lower(coalesce(description_en, ''))))
  ) STORED,

  search_vector_id tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', unaccent(lower(coalesce(description_id, ''))))
  ) STORED,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Constraints
  -- Validate code format: 2, 4, or 6 digits only (prevents codes like '94A500')
  CONSTRAINT hs_codes_code_check CHECK (
    code ~ '^[0-9]{2}([0-9]{2}){0,2}$'
  ),

  -- Multi-jurisdiction support: unique per jurisdiction/year
  CONSTRAINT hs_codes_unique_code UNIQUE (jurisdiction, version_year, code),

  -- Foreign key to parent (deferrable to allow bulk insert without ordering)
  -- Composite FK ensures parent is in same jurisdiction/year
  CONSTRAINT hs_codes_parent_fkey FOREIGN KEY (jurisdiction, version_year, parent_code)
    REFERENCES hs_codes(jurisdiction, version_year, code)
    DEFERRABLE INITIALLY DEFERRED
);

-- ============================================================================
-- PART 3B: AUTO-UPDATE TRIGGER FOR updated_at
-- ============================================================================

-- Function to auto-update updated_at on row changes
CREATE OR REPLACE FUNCTION update_hs_codes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to call the function before any UPDATE
DROP TRIGGER IF EXISTS trigger_update_hs_codes_updated_at ON hs_codes;
CREATE TRIGGER trigger_update_hs_codes_updated_at
  BEFORE UPDATE ON hs_codes
  FOR EACH ROW
  EXECUTE FUNCTION update_hs_codes_updated_at();

-- ============================================================================
-- PART 4: INDEXES
-- ============================================================================

-- Index 1: Exact lookup by code (btree) - O(log n) for "WHERE code = '940500'"
CREATE INDEX IF NOT EXISTS idx_hs_codes_jurisdiction_version_code
  ON hs_codes(jurisdiction, version_year, code);

-- Index 2: Prefix search (text_pattern_ops) - Fast for "WHERE code LIKE '9405%'"
CREATE INDEX IF NOT EXISTS idx_hs_codes_code_pattern
  ON hs_codes(code text_pattern_ops);

-- Index 3: Full-text search - English descriptions
CREATE INDEX IF NOT EXISTS idx_hs_codes_search_en
  ON hs_codes USING GIN(search_vector_en);

-- Index 4: Full-text search - Indonesian descriptions
CREATE INDEX IF NOT EXISTS idx_hs_codes_search_id
  ON hs_codes USING GIN(search_vector_id);

-- Index 5: Trigram fuzzy search - English (fallback for typos)
CREATE INDEX IF NOT EXISTS idx_hs_codes_description_en_trgm
  ON hs_codes USING GIN(description_en gin_trgm_ops);

-- Index 6: Trigram fuzzy search - Indonesian (fallback for typos)
CREATE INDEX IF NOT EXISTS idx_hs_codes_description_id_trgm
  ON hs_codes USING GIN(description_id gin_trgm_ops);

-- Index 7: Parent code for hierarchy traversal
CREATE INDEX IF NOT EXISTS idx_hs_codes_parent
  ON hs_codes(parent_code) WHERE parent_code IS NOT NULL;

-- Index 8: Level filtering
CREATE INDEX IF NOT EXISTS idx_hs_codes_level
  ON hs_codes(level);

-- ============================================================================
-- PART 5: STAGING TABLE FOR BULK IMPORT
-- ============================================================================

CREATE TEMP TABLE IF NOT EXISTS hs_codes_staging (
  code VARCHAR(6),
  level VARCHAR(10),
  parent_code VARCHAR(6),
  description_en TEXT,
  description_id TEXT,
  jurisdiction VARCHAR(10),
  version_year INTEGER
);

-- ============================================================================
-- PART 6: BULK IMPORT FROM CSV
-- ============================================================================

-- Copy CSV data into staging table
COPY hs_codes_staging(code, level, parent_code, description_en, description_id, jurisdiction, version_year)
FROM '/Users/budionodarmawan/Websites/simplitx/services/web/prisma/hscodes_filtered.csv'
WITH (FORMAT csv, HEADER true, DELIMITER ',', QUOTE '"', ESCAPE '"');

-- ============================================================================
-- PART 7: UPSERT INTO MAIN TABLE
-- ============================================================================

-- Insert or update from staging to main table
INSERT INTO hs_codes (code, level, parent_code, description_en, description_id, jurisdiction, version_year)
SELECT
  code,
  level::hs_level,
  NULLIF(parent_code, ''),
  description_en,
  description_id,
  COALESCE(jurisdiction, 'ID'),
  COALESCE(version_year, 2022)
FROM hs_codes_staging
ON CONFLICT (jurisdiction, version_year, code)
DO UPDATE SET
  description_en = EXCLUDED.description_en,
  description_id = EXCLUDED.description_id,
  parent_code = EXCLUDED.parent_code,
  updated_at = NOW();

-- NULL any orphaned parent references (parents that don't exist in the table)
UPDATE hs_codes hc
SET parent_code = NULL
WHERE parent_code IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM hs_codes parent
    WHERE parent.code = hc.parent_code
      AND parent.jurisdiction = hc.jurisdiction
      AND parent.version_year = hc.version_year
  );

-- ============================================================================
-- PART 8: BREADCRUMBS VIEW (HS6 -> HS4 -> HS2)
-- ============================================================================

CREATE OR REPLACE VIEW hs_codes_breadcrumbs AS
SELECT
  hs6.id,
  hs6.code,
  hs6.level,
  hs6.description_en,
  hs6.description_id,

  -- HS4 parent
  hs4.code AS hs4_code,
  hs4.description_en AS hs4_description_en,
  hs4.description_id AS hs4_description_id,

  -- HS2 grandparent
  hs2.code AS hs2_code,
  hs2.description_en AS hs2_description_en,
  hs2.description_id AS hs2_description_id,

  hs6.jurisdiction,
  hs6.version_year
FROM hs_codes hs6
LEFT JOIN hs_codes hs4
  ON hs6.parent_code = hs4.code
  AND hs6.jurisdiction = hs4.jurisdiction
  AND hs6.version_year = hs4.version_year
LEFT JOIN hs_codes hs2
  ON hs4.parent_code = hs2.code
  AND hs4.jurisdiction = hs2.jurisdiction
  AND hs4.version_year = hs2.version_year
WHERE hs6.level = 'HS6';

-- ============================================================================
-- PART 9: HELPER FUNCTION FOR LOOKUP
-- ============================================================================

-- Fast lookup function: get HS code by exact code
CREATE OR REPLACE FUNCTION get_hs_code(p_code VARCHAR(6), p_jurisdiction VARCHAR(10) DEFAULT 'ID', p_version_year INTEGER DEFAULT 2022)
RETURNS TABLE (
  id UUID,
  code VARCHAR(6),
  level hs_level,
  description_en TEXT,
  description_id TEXT,
  parent_code VARCHAR(6)
) AS $$
BEGIN
  RETURN QUERY
  SELECT hc.id, hc.code, hc.level, hc.description_en, hc.description_id, hc.parent_code
  FROM hs_codes hc
  WHERE hc.code = p_code
    AND hc.jurisdiction = p_jurisdiction
    AND hc.version_year = p_version_year;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- PART 10: SANITY CHECKS & SUMMARY
-- ============================================================================

-- Summary by level
SELECT level, COUNT(*) as count
FROM hs_codes
WHERE jurisdiction = 'ID' AND version_year = 2022
GROUP BY level
ORDER BY level;

-- Check for orphaned parents
SELECT code, parent_code
FROM hs_codes hc
WHERE parent_code IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM hs_codes parent
    WHERE parent.code = hc.parent_code
      AND parent.jurisdiction = hc.jurisdiction
      AND parent.version_year = hc.version_year
  )
LIMIT 10;

-- ============================================================================
-- EXAMPLE QUERIES (FOR TESTING)
-- ============================================================================

-- Example 1: Exact lookup (instant with btree index)
-- SELECT * FROM get_hs_code('940500');
-- Or:
-- SELECT id, code, level, description_en, description_id
-- FROM hs_codes
-- WHERE code = '940500' AND jurisdiction = 'ID' AND version_year = 2022;

-- Example 2: Prefix search (find all codes starting with 9405)
-- SELECT code, description_en
-- FROM hs_codes
-- WHERE code LIKE '9405%'
--   AND jurisdiction = 'ID'
--   AND version_year = 2022
-- ORDER BY code;

-- Example 3: Full-text search (English)
-- SELECT code, description_en,
--        ts_rank(search_vector_en, query) AS rank
-- FROM hs_codes, to_tsquery('english', 'furniture | lighting') query
-- WHERE search_vector_en @@ query
--   AND jurisdiction = 'ID'
--   AND version_year = 2022
-- ORDER BY rank DESC
-- LIMIT 10;

-- Example 4: Full-text search (Indonesian)
-- SELECT code, description_id,
--        ts_rank(search_vector_id, query) AS rank
-- FROM hs_codes, to_tsquery('simple', 'mebel | penerangan') query
-- WHERE search_vector_id @@ query
--   AND jurisdiction = 'ID'
--   AND version_year = 2022
-- ORDER BY rank DESC
-- LIMIT 10;

-- Example 5: Fuzzy/trigram search (for typos)
-- SELECT code, description_en,
--        similarity(description_en, 'furnitur') AS sim
-- FROM hs_codes
-- WHERE description_en % 'furnitur'
--   AND jurisdiction = 'ID'
--   AND version_year = 2022
-- ORDER BY sim DESC
-- LIMIT 10;

-- Example 6: Get breadcrumbs for an HS6 code
-- SELECT hs2_code, hs2_description_en,
--        hs4_code, hs4_description_en,
--        code, description_en
-- FROM hs_codes_breadcrumbs
-- WHERE code = '940500';

-- Example 7: Get all children of an HS4 code
-- SELECT code, description_en
-- FROM hs_codes
-- WHERE parent_code = '9405'
--   AND jurisdiction = 'ID'
--   AND version_year = 2022
-- ORDER BY code;

-- ============================================================================
-- NOTES:
--
-- 1. To import data, uncomment the COPY and INSERT sections in PART 6 & 7
-- 2. Ensure hscodes_filtered.csv is accessible at the specified path
-- 3. After import, run the summary queries to verify data integrity
-- 4. The parent FK is deferrable to allow bulk insert without strict ordering
-- 5. Embeddings column is optional - uncomment if pgvector is available
-- 6. All indexes are designed for read-heavy workloads (invoice processing)
-- 7. Generated columns (search_vector_en/id) auto-update on description changes
-- ============================================================================
