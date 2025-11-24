#!/usr/bin/env python3
"""
Stage s02 - validate and resolve buyers.

Responsibility:
- Validate imported Sensient rows for a given batch_id.
- Resolve buyer_party_id from buyer_name_raw using parties in the database (exact + fuzzy).
- Write buyer_party_id and buyer_match_confidence back to public."temporaryStaging".
"""

import argparse
import os
import sys
from typing import Dict, List, Tuple

import pandas as pd
import psycopg2
from fuzzywuzzy import fuzz, process
from psycopg2.extras import execute_batch


# Database connection parameters from environment
DB_CONFIG = {
    'host': os.getenv('DB_HOST', 'localhost'),
    'port': os.getenv('DB_PORT', '5432'),
    'database': os.getenv('DB_NAME', 'postgres'),
    'user': os.getenv('DB_USER', 'postgres'),
    'password': os.getenv('DB_PASSWORD', ''),
}

FUZZY_THRESHOLD = 70
AMOUNT_TOLERANCE_RATIO = 0.01
AMOUNT_TOLERANCE_ABS = 0.01
REQUIRED_FIELDS = ['invoice', 'buyer_name_raw', 'input_quantity', 'unit_price', 'amount']


def get_db_connection():
    """Create and return a database connection."""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        return conn
    except Exception as e:
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


def load_batch_rows(conn, batch_id: str) -> pd.DataFrame:
    """Load rows for a given batch_id from temporaryStaging."""
    query = """
    SELECT
        id,
        batch_id,
        buyer_name_raw,
        buyer_party_id,
        invoice,
        input_quantity,
        unit_price,
        amount
    FROM public."temporaryStaging"
    WHERE batch_id = %s
    """
    return pd.read_sql_query(query, conn, params=(batch_id,))


def to_number(value) -> float:
    """Best-effort conversion to float, returning None for blanks."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        return float(value)
    except Exception:
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


def update_buyer_resolution(conn, updates: List[Tuple[str, int, str]]):
    """Apply buyer resolution results back to temporaryStaging."""
    if not updates:
        return

    update_sql = """
    UPDATE public."temporaryStaging"
    SET buyer_party_id = %s,
        buyer_match_confidence = %s
    WHERE id = %s
    """
    with conn.cursor() as cur:
        execute_batch(cur, update_sql, updates, page_size=1000)
    conn.commit()


def process_batch(conn, batch_id: str):
    """Validate rows and resolve buyers for the provided batch_id."""
    ensure_temp_staging_columns(conn)
    df = load_batch_rows(conn, batch_id)

    if df.empty:
        print(f"⚠️  No rows found in public.\"temporaryStaging\" for batch_id={batch_id}")
        return

    parties_dict = get_all_parties(conn)
    print(f"📊 Loaded {len(parties_dict)} parties for matching")

    total_rows = len(df)
    validation_failures = 0
    resolved_confident = 0
    unresolved_or_low = 0
    updates: List[Tuple[str, int, str]] = []

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

        updates.append((party_id, confidence, row['id']))

    update_buyer_resolution(conn, updates)

    print("\n" + "=" * 70)
    print("  BATCH VALIDATION & BUYER RESOLUTION SUMMARY")
    print("=" * 70)
    print(f"Batch ID:                        {batch_id}")
    print(f"Rows processed:                  {total_rows}")
    print(f"Rows with validation issues:     {validation_failures}")
    print(f"Resolved buyers (>= {FUZZY_THRESHOLD}%):   {resolved_confident}")
    print(f"Unresolved or low confidence:    {unresolved_or_low}")
    print("=" * 70)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Validate Sensient temporaryStaging data and resolve buyers for a batch_id"
    )
    parser.add_argument(
        '--batch-id',
        required=True,
        help='Batch identifier printed by s01_postgreimport_sensient.py'
    )
    return parser.parse_args()


def main():
    args = parse_args()
    conn = get_db_connection()
    try:
        process_batch(conn, args.batch_id)
    except Exception as e:
        print(f"\n❌ Error during validation/resolution: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
