-- Create tables for Kurs Pajak periods and rates

CREATE TABLE IF NOT EXISTS fx_kurs_period (
    id BIGSERIAL PRIMARY KEY,
    week_start DATE NOT NULL,
    week_end DATE NOT NULL,
    kmk_number TEXT NOT NULL,
    kmk_url TEXT NOT NULL,
    source_url TEXT NOT NULL,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT fx_kurs_period_unique_week UNIQUE (week_start, week_end)
);

CREATE OR REPLACE FUNCTION set_fx_kurs_period_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fx_kurs_period_updated_at ON fx_kurs_period;
CREATE TRIGGER trg_fx_kurs_period_updated_at
BEFORE UPDATE ON fx_kurs_period
FOR EACH ROW
EXECUTE FUNCTION set_fx_kurs_period_updated_at();

CREATE TABLE IF NOT EXISTS fx_kurs_rate (
    period_id BIGINT NOT NULL REFERENCES fx_kurs_period(id) ON DELETE CASCADE,
    iso_code CHAR(3) NOT NULL,
    unit INTEGER NOT NULL DEFAULT 1,
    value_idr NUMERIC(18,2) NOT NULL,
    collected_at TIMESTAMPTZ DEFAULT NOW(),
    source TEXT,
    PRIMARY KEY (period_id, iso_code)
);

CREATE INDEX IF NOT EXISTS idx_fx_kurs_rate_iso ON fx_kurs_rate (iso_code);
CREATE INDEX IF NOT EXISTS idx_fx_kurs_period_week_start ON fx_kurs_period (week_start DESC);
