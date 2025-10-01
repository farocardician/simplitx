-- ============================================================================
-- PARTIES TABLE MIGRATION: Production-Safe Name → TIN Resolution
-- ============================================================================

-- Create parties table
CREATE TABLE IF NOT EXISTS parties (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name      TEXT NOT NULL,
  name_normalized   TEXT NOT NULL,
  tin_display       TEXT NOT NULL,
  tin_normalized    TEXT NOT NULL,
  country_code      CHAR(3) NULL,
  address_full      TEXT NULL,
  email             TEXT NULL,
  deleted_at        TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        TEXT NULL,
  updated_by        TEXT NULL,

  CONSTRAINT chk_tin_display_not_empty
    CHECK (length(trim(tin_display)) > 0),

  CONSTRAINT chk_country_code_format
    CHECK (
      country_code IS NULL
      OR (length(country_code) = 3 AND country_code = upper(country_code))
    )
);

-- ============================================================================
-- NORMALIZATION FUNCTIONS (Single Source of Truth)
-- ============================================================================

CREATE OR REPLACE FUNCTION normalize_party_name(display_name TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN upper(trim(regexp_replace(
    regexp_replace(
      regexp_replace(display_name, E'[,.\'"]', '', 'g'),
      E'\\s+', ' ', 'g'
    ),
    E'[-]+', '-', 'g'
  )));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION normalize_tin(tin_display TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN upper(regexp_replace(trim(tin_display), E'[\\s.\\-/]', '', 'g'));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================================
-- AUTO-NORMALIZATION TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION auto_normalize_party_fields()
RETURNS TRIGGER AS $$
BEGIN
  NEW.name_normalized := normalize_party_name(NEW.display_name);
  NEW.tin_normalized := normalize_tin(NEW.tin_display);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_normalize_party_fields ON parties;
CREATE TRIGGER trg_auto_normalize_party_fields
BEFORE INSERT OR UPDATE ON parties
FOR EACH ROW
EXECUTE FUNCTION auto_normalize_party_fields();

-- ============================================================================
-- COLLISION DETECTION TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION check_name_tin_collision()
RETURNS TRIGGER AS $$
DECLARE
  existing_tin TEXT;
BEGIN
  SELECT tin_normalized INTO existing_tin
  FROM parties
  WHERE name_normalized = NEW.name_normalized
    AND deleted_at IS NULL
    AND id != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF FOUND AND existing_tin != NEW.tin_normalized THEN
    RAISE EXCEPTION 'Name collision: "%" already exists with different TIN. Existing: %, New: %. Manual resolution required.',
      NEW.display_name, existing_tin, NEW.tin_normalized
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_name_tin_collision ON parties;
CREATE TRIGGER trg_check_name_tin_collision
BEFORE INSERT OR UPDATE ON parties
FOR EACH ROW
EXECUTE FUNCTION check_name_tin_collision();

-- ============================================================================
-- COUNTRY CODE BACKFILL SAFEGUARD TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION validate_country_code_update()
RETURNS TRIGGER AS $$
DECLARE
  collision_count INT;
BEGIN
  IF OLD.country_code IS NULL AND NEW.country_code IS NOT NULL THEN
    SELECT COUNT(*) INTO collision_count
    FROM parties
    WHERE country_code = NEW.country_code
      AND tin_normalized = NEW.tin_normalized
      AND deleted_at IS NULL
      AND id != NEW.id;

    IF collision_count > 0 THEN
      RAISE EXCEPTION 'Cannot set country_code to %: TIN % already exists in this country',
        NEW.country_code, NEW.tin_display
        USING ERRCODE = '23505';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_country_code_update ON parties;
CREATE TRIGGER trg_validate_country_code_update
BEFORE UPDATE ON parties
FOR EACH ROW
EXECUTE FUNCTION validate_country_code_update();

-- ============================================================================
-- UPDATED_AT AUTO-UPDATE TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION update_parties_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_parties_updated_at ON parties;
CREATE TRIGGER trg_parties_updated_at
BEFORE UPDATE ON parties
FOR EACH ROW
EXECUTE FUNCTION update_parties_updated_at();

-- ============================================================================
-- UNIQUE CONSTRAINTS (Active Records Only)
-- ============================================================================

-- UC1: Active name uniqueness (global)
DROP INDEX IF EXISTS idx_parties_name_normalized_active;
CREATE UNIQUE INDEX idx_parties_name_normalized_active
ON parties (name_normalized)
WHERE deleted_at IS NULL;

-- UC2: Active TIN uniqueness (country-scoped)
DROP INDEX IF EXISTS idx_parties_tin_normalized_with_country;
CREATE UNIQUE INDEX idx_parties_tin_normalized_with_country
ON parties (country_code, tin_normalized)
WHERE deleted_at IS NULL AND country_code IS NOT NULL;

-- UC3: Active TIN uniqueness (no country)
DROP INDEX IF EXISTS idx_parties_tin_normalized_no_country;
CREATE UNIQUE INDEX idx_parties_tin_normalized_no_country
ON parties (tin_normalized)
WHERE deleted_at IS NULL AND country_code IS NULL;

-- ============================================================================
-- LOOKUP INDEX (Non-Unique)
-- ============================================================================

-- For soft-deleted record queries
DROP INDEX IF EXISTS idx_parties_deleted_at;
CREATE INDEX idx_parties_deleted_at
ON parties (deleted_at)
WHERE deleted_at IS NOT NULL;

-- ============================================================================
-- TABLE COMMENTS (Documentation)
-- ============================================================================

COMMENT ON TABLE parties IS 'Party master data for name → TIN resolution with soft delete support';
COMMENT ON COLUMN parties.display_name IS 'Original party name (with formatting, shown to users)';
COMMENT ON COLUMN parties.name_normalized IS 'Auto-generated normalized name (never written by clients)';
COMMENT ON COLUMN parties.tin_display IS 'Original TIN with formatting (dots, dashes)';
COMMENT ON COLUMN parties.tin_normalized IS 'Auto-generated normalized TIN (stripped, for uniqueness)';
COMMENT ON COLUMN parties.deleted_at IS 'Soft delete timestamp (NULL = active record)';
COMMENT ON COLUMN parties.created_by IS 'User/system that created this record';
COMMENT ON COLUMN parties.updated_by IS 'User/system that last modified this record';
