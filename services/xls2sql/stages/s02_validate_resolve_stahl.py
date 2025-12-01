#!/usr/bin/env python3
"""
Stage s02 - validate and resolve buyers for Stahl.

Responsibility:
- Validate imported rows for a given job_id.
- Resolve buyer_party_id from buyer_name_raw using parties in the database (exact + fuzzy).
- Normalize HS codes: Stahl source provides only 6 digits; prefix with type.code from config when missing.
- Write buyer_party_id, buyer_match_confidence, and normalized hs_code back to public."temporaryStaging".
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pandas as pd
import psycopg2
from fuzzywuzzy import fuzz, process
from psycopg2.extras import execute_batch


# Database connection parameters from environment (no fallbacks)
def _get_db_config():
    """Get database config from environment variables.

    Raises:
        RuntimeError if required database environment variables are not set
    """
    required_vars = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']
    missing = [var for var in required_vars if not os.getenv(var)]
    if missing:
        raise RuntimeError(
            f"Missing required database environment variables: {missing}. "
            f"Set {', '.join(missing)} environment variable(s)."
        )
    return {
        'host': os.getenv('DB_HOST'),
        'port': os.getenv('DB_PORT'),
        'database': os.getenv('DB_NAME'),
        'user': os.getenv('DB_USER'),
        'password': os.getenv('DB_PASSWORD'),
    }


DB_CONFIG = _get_db_config()

FUZZY_THRESHOLD = 70
AMOUNT_TOLERANCE_RATIO = 0.01
AMOUNT_TOLERANCE_ABS = 0.01
REQUIRED_FIELDS = ['invoice', 'buyer_name_raw', 'input_quantity', 'unit_price', 'amount']
DEFAULT_CONFIG = "services/config/invoice_pt_stahl.json"


def get_db_connection():
    """Create and return a database connection."""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        return conn
    except Exception as e:  # noqa: BLE001
        print(f"❌ Error connecting to database: {e}")
        sys.exit(1)


def ensure_temp_staging_columns(conn):
    """Add columns needed by the pipeline if they do not exist yet."""
    alter_sql = """
    ALTER TABLE public."temporaryStaging"
        ADD COLUMN IF NOT EXISTS buyer_name_raw text,
        ADD COLUMN IF NOT EXISTS buyer_match_confidence double precision;
    """
    with conn.cursor() as cur:
        cur.execute(alter_sql)
    conn.commit()


def normalize_name(value: str) -> str:
    """Lowercase and squeeze whitespace for consistent matching."""
    if value is None or pd.isna(value):
        return ''
    return ' '.join(str(value).lower().strip().split())


def get_all_parties(conn) -> Dict[str, str]:
    """
    Retrieve all parties from database and return as dict {normalized_name: id}.
    IDs are UUIDs stored as strings.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT id, display_name FROM public.parties WHERE deleted_at IS NULL")
        parties = cur.fetchall()
        return {normalize_name(name): str(party_id) for party_id, name in parties}


def load_job_rows(conn, job_id: str) -> pd.DataFrame:
    """Load rows for a given job_id from temporaryStaging."""
    query = """
    SELECT
        id,
        job_id,
        buyer_name_raw,
        buyer_party_id,
        invoice,
        input_quantity,
        unit_price,
        amount,
        hs_code
    FROM public."temporaryStaging"
    WHERE job_id = %s
    """
    return pd.read_sql_query(query, conn, params=(job_id,))


def to_number(value) -> float:
    """Best-effort conversion to float, returning None for blanks."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        return float(value)
    except Exception:  # noqa: BLE001
        return None


def validate_row(row: pd.Series) -> List[str]:
    """Validate required fields and arithmetic consistency."""
    issues: List[str] = []

    # Required presence checks
    for field in REQUIRED_FIELDS:
        val = row.get(field)
        if val is None or (isinstance(val, str) and not val.strip()) or pd.isna(val):
            issues.append(f"Missing {field}")

    qty = to_number(row.get('input_quantity'))
    price = to_number(row.get('unit_price'))
    amount = to_number(row.get('amount'))

    if qty is not None and price is not None and amount is not None:
        expected = qty * price
        tolerance = max(abs(expected) * AMOUNT_TOLERANCE_RATIO, AMOUNT_TOLERANCE_ABS)
        if abs(expected - amount) > tolerance:
            issues.append(
                f"Amount mismatch: qty*unit_price={expected:.2f} vs amount={amount:.2f} (tolerance {tolerance:.2f})"
            )

    return issues


def resolve_buyer_party_id(
    buyer_name: str,
    parties_dict: Dict[str, str],
    fuzzy_threshold: int = FUZZY_THRESHOLD
) -> Tuple[str, str, int]:
    """
    Resolve buyer_party_id from buyer_name using exact then fuzzy matching.

    Returns:
        Tuple of (party_id or None, matched_name or None, confidence 0-100)
    """
    normalized_name = normalize_name(buyer_name)
    if not normalized_name:
        return None, None, 0

    # Try exact match
    if normalized_name in parties_dict:
        return parties_dict[normalized_name], normalized_name, 100

    # Fuzzy match
    party_names = list(parties_dict.keys())
    best_match = process.extractOne(
        normalized_name,
        party_names,
        scorer=fuzz.ratio
    )

    if best_match:
        matched_name, score = best_match
        if score >= fuzzy_threshold:
            return parties_dict[matched_name], matched_name, score
        return None, matched_name, score

    return None, None, 0


def _resolve_config_path(config_arg: str) -> Optional[Path]:
    """Locate config file similar to other stages."""
    candidates = []
    provided = Path(config_arg)
    if provided.is_absolute():
        candidates.append(provided)
    else:
        candidates.append(provided)
        config_dir = os.getenv("CONFIG_DIR")
        if config_dir:
            candidates.append(Path(config_dir) / config_arg)

        current_file = Path(__file__).resolve()
        seen = set()
        for parent in current_file.parents:
            for option in (
                parent / config_arg,
                parent / "config" / config_arg,
                parent / "services" / "config" / config_arg,
            ):
                if option in seen:
                    continue
                seen.add(option)
                candidates.append(option)

    for path in candidates:
        if path.exists():
            return path
    return None


def load_type_code(config_arg: str) -> Tuple[Optional[str], Optional[Path]]:
    """Load type.code from config for HS prefixing."""
    config_path = _resolve_config_path(config_arg)
    if not config_path:
        print(f"⚠️  Config '{config_arg}' not found - HS codes will not be prefixed")
        return None, None

    try:
        data = json.loads(config_path.read_text(encoding='utf-8'))
        type_code = data.get('type', {}).get('code') or data.get('type', {}).get('alias')
        if type_code:
            type_code = str(type_code).strip().upper()[:1]
        return type_code, config_path
    except Exception as exc:  # noqa: BLE001
        print(f"⚠️  Failed to read config {config_path}: {exc} - HS codes will not be prefixed")
        return None, config_path


def normalize_hs_code_value(hs_code: Optional[str], type_code: Optional[str]) -> Optional[str]:
    """Normalize HS code, prefixing with type code when missing."""
    if hs_code is None or (isinstance(hs_code, str) and not hs_code.strip()) or pd.isna(hs_code):
        return None

    text = str(hs_code).strip().upper()

    # Already in expected format (A/B + 6 digits)
    if re.fullmatch(r'[A-Z]\d{6}', text):
        return text

    digits_only = re.sub(r'\D', '', text)
    if len(digits_only) >= 6:
        six_digits = digits_only[:6]
        prefix = (type_code or '').strip().upper()[:1]
        return f"{prefix}{six_digits}" if prefix else six_digits

    return text


def update_staging(conn, updates: List[Tuple[str, int, Optional[str], str]]):
    """Apply buyer resolution and HS normalization back to temporaryStaging."""
    if not updates:
        return

    update_sql = """
    UPDATE public."temporaryStaging"
    SET buyer_party_id = %s,
        buyer_match_confidence = %s,
        hs_code = %s
    WHERE id = %s
    """
    with conn.cursor() as cur:
        execute_batch(cur, update_sql, updates, page_size=1000)
    conn.commit()


def process_job(conn, job_id: str, type_code: Optional[str]):
    """Validate rows and resolve buyers for the provided job_id."""
    ensure_temp_staging_columns(conn)
    df = load_job_rows(conn, job_id)

    if df.empty:
        print(f"⚠️  No rows found in public.\"temporaryStaging\" for job_id={job_id}")
        return

    parties_dict = get_all_parties(conn)
    print(f"📊 Loaded {len(parties_dict)} parties for matching")

    total_rows = len(df)
    validation_failures = 0
    resolved_confident = 0
    unresolved_or_low = 0
    hs_normalized = 0
    updates: List[Tuple[str, int, Optional[str], str]] = []

    for _, row in df.iterrows():
        row_issues = validate_row(row)
        if row_issues:
            validation_failures += 1
            invoice_label = row.get('invoice') if not pd.isna(row.get('invoice')) else '(no invoice)'
            print(f"  ⚠️  Validation issues for row id={row['id']} invoice={invoice_label}: {', '.join(row_issues)}")

        party_id, matched_name, confidence = resolve_buyer_party_id(row.get('buyer_name_raw'), parties_dict)
        if party_id and confidence >= FUZZY_THRESHOLD:
            resolved_confident += 1
        else:
            unresolved_or_low += 1
            party_id = None  # Never persist a low-confidence match

        normalized_hs = normalize_hs_code_value(row.get('hs_code'), type_code)
        if normalized_hs and normalized_hs != row.get('hs_code'):
            hs_normalized += 1

        # Keep original hs_code when normalization returns None
        hs_value_to_store = normalized_hs if normalized_hs is not None else row.get('hs_code')
        updates.append((party_id, confidence, hs_value_to_store, row['id']))

    update_staging(conn, updates)

    print("\n" + "=" * 70)
    print("  BATCH VALIDATION & BUYER RESOLUTION SUMMARY")
    print("=" * 70)
    print(f"Batch ID:                        {job_id}")
    print(f"Rows processed:                  {total_rows}")
    print(f"Rows with validation issues:     {validation_failures}")
    print(f"Resolved buyers (>= {FUZZY_THRESHOLD}%):   {resolved_confident}")
    print(f"Unresolved or low confidence:    {unresolved_or_low}")
    print(f"HS codes normalized:             {hs_normalized}")
    print("=" * 70)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Validate Stahl temporaryStaging data and resolve buyers for a job_id"
    )
    parser.add_argument(
        '--job-id',
        dest='job_id',
        required=True,
        help='Job identifier printed by s01_postgreimport_stahl.py'
    )
    parser.add_argument(
        '--config',
        default=DEFAULT_CONFIG,
        help='Path or name of Stahl pipeline config (used to derive type.code for HS prefixing)'
    )
    return parser.parse_args()


def main():
    import time
    script_start = time.time()

    args = parse_args()

    type_code, config_path = load_type_code(args.config)
    if type_code:
        print(f"Using type code '{type_code}' from {config_path}")
    else:
        print("⚠️  No type code available - HS codes will remain unchanged if missing prefixes")

    t1 = time.time()
    print("⏱️  Connecting to database...")
    conn = get_db_connection()
    print(f"✓ Database connected in {(time.time() - t1)*1000:.0f}ms")

    try:
        t2 = time.time()
        print("⏱️  Starting validation/resolution...")
        process_job(conn, args.job_id, type_code)
        print(f"✓ Validation/resolution completed in {(time.time() - t2)*1000:.0f}ms")
        print(f"⏱️  TOTAL SCRIPT TIME: {(time.time() - script_start)*1000:.0f}ms")
    except Exception as e:  # noqa: BLE001
        print(f"\n❌ Error during validation/resolution: {e}")
        print(f"⏱️  Failed after {(time.time() - script_start)*1000:.0f}ms")
        import traceback

        traceback.print_exc()
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
