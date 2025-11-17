-- ============================================================================
-- ADD BUYER FIELDS TO PARTIES TABLE
-- ============================================================================
-- Adds BuyerDocument, BuyerDocumentNumber, and BuyerIDTKU fields for invoice processing

-- Add new columns
ALTER TABLE parties
ADD COLUMN IF NOT EXISTS buyer_document VARCHAR(50) DEFAULT 'TIN',
ADD COLUMN IF NOT EXISTS buyer_document_number VARCHAR(100) NULL,
ADD COLUMN IF NOT EXISTS buyer_idtku VARCHAR(100) NULL;

-- ============================================================================
-- AUTO-CALCULATE BUYER_IDTKU TRIGGER
-- ============================================================================
-- BuyerIDTKU = tin_normalized + '000000' (6 zeros)
-- Example: tin_normalized '0849873807086000' → buyer_idtku '0849873807086000000000'

CREATE OR REPLACE FUNCTION auto_calculate_buyer_idtku()
RETURNS TRIGGER AS $$
BEGIN
  -- Only auto-calculate if buyer_idtku is NULL
  -- This allows manual override while providing sensible default
  IF NEW.buyer_idtku IS NULL THEN
    NEW.buyer_idtku := NEW.tin_normalized || '000000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_calculate_buyer_idtku ON parties;
CREATE TRIGGER trg_auto_calculate_buyer_idtku
BEFORE INSERT OR UPDATE ON parties
FOR EACH ROW
EXECUTE FUNCTION auto_calculate_buyer_idtku();

-- ============================================================================
-- BACKFILL EXISTING RECORDS
-- ============================================================================
-- Set buyer_document to 'TIN' for all existing records (if not already set)
UPDATE parties
SET buyer_document = 'TIN'
WHERE buyer_document IS NULL;

-- Calculate buyer_idtku for all existing records (if not already set)
UPDATE parties
SET buyer_idtku = tin_normalized || '000000'
WHERE buyer_idtku IS NULL;

-- ============================================================================
-- TABLE COMMENTS (Documentation)
-- ============================================================================
COMMENT ON COLUMN parties.buyer_document IS 'Document type for buyer identification (default: TIN, can be edited or nulled)';
COMMENT ON COLUMN parties.buyer_document_number IS 'Document number for buyer (optional, empty by default)';
COMMENT ON COLUMN parties.buyer_idtku IS 'Buyer IDTKU identifier (auto-calculated: tin_normalized + 000000, can be manually overridden)';
