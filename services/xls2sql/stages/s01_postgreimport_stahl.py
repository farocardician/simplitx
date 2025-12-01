#!/usr/bin/env python3
"""
Stage s01 for Stahl.

Responsibility:
- Read Stahl FK/OF Excel layout and map it directly into public."temporaryStaging".
- One staging row per invoice line (OF) using the surrounding FK header row for invoice/buyer context.
- Use invoice_pt_stahl.json for static fields such as UOM, currency, and HS code.
"""

import argparse
import json
import os
import re
import sys
import uuid
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import pandas as pd
import psycopg2
from psycopg2 import sql
from psycopg2.extras import execute_batch

# Target staging table and column order
STAGING_TABLE = 'temporaryStaging'
STAGING_COLUMNS = [
    'job_id',
    'buyer_name_raw',
    'buyer_party_id',
    'invoice',
    'ship_date',
    'item_description',
    'input_quantity',
    'input_uom',
    'total_kg',
    'unit_price',
    'amount',
    'currency',
    'hs_code',
    'buyer_match_confidence',
]

# Header tokens used to detect header rows vs data rows
FK_HEADER_TOKEN = 'KD_JENIS_TRANSAKSI'
OF_HEADER_TOKEN = 'KODE_OBJEK'
LT_HEADER_TOKEN = 'NPWP'


def _get_db_config() -> Dict[str, Any]:
    """Fetch database connection settings from the environment."""
    host = os.getenv('PGHOST') or os.getenv('DB_HOST')
    port = os.getenv('PGPORT') or os.getenv('DB_PORT')
    database = os.getenv('PGDATABASE') or os.getenv('DB_NAME')
    user = os.getenv('PGUSER') or os.getenv('DB_USER')
    password = os.getenv('PGPASSWORD') or os.getenv('DB_PASSWORD')

    missing = []
    if not host:
        missing.append('PGHOST or DB_HOST')
    if not port:
        missing.append('PGPORT or DB_PORT')
    if not database:
        missing.append('PGDATABASE or DB_NAME')
    if not user:
        missing.append('PGUSER or DB_USER')
    if not password:
        missing.append('PGPASSWORD or DB_PASSWORD')

    if missing:
        raise RuntimeError(
            f"Missing required database environment variables: {', '.join(missing)}"
        )

    return {
        'host': host,
        'port': int(port),
        'database': database,
        'user': user,
        'password': password,
    }


def _clean_str(value: Any) -> Optional[str]:
    """Return a trimmed string or None for empty/NaN values."""
    if value is None:
        return None
    if isinstance(value, float) and pd.isna(value):
        return None
    text = str(value).strip()
    return text or None


def _parse_decimal(value: Any) -> Optional[Decimal]:
    """Parse numeric-looking values into Decimal for DB insertion."""
    if value is None:
        return None
    if isinstance(value, float) and pd.isna(value):
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))

    text = _clean_str(value)
    if not text:
        return None

    normalized = text.replace(' ', '')
    # Handle comma-only decimals (e.g., "1,25")
    if normalized.count(',') == 1 and normalized.count('.') == 0:
        normalized = normalized.replace(',', '.')
    else:
        normalized = normalized.replace(',', '')

    # Remove stray thousand separators if multiple dots exist
    if normalized.count('.') > 1:
        normalized = normalized.replace('.', '')

    try:
        return Decimal(normalized)
    except InvalidOperation:
        return None


def _parse_ship_date(value: Any) -> Optional[str]:
    """Parse various date representations into YYYY-MM-DD strings."""
    if value is None:
        return None
    if isinstance(value, pd.Timestamp):
        return value.date().isoformat()
    if isinstance(value, datetime):
        return value.date().isoformat()

    text = _clean_str(value)
    if not text:
        return None

    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%m/%d/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue

    parsed = pd.to_datetime(text, dayfirst=True, errors='coerce')
    if pd.notna(parsed):
        return parsed.date().isoformat()
    return None


def _normalize_invoice(value: Any) -> Optional[str]:
    """Preserve leading zeros while removing trailing .0 artifacts."""
    text = _clean_str(value)
    if not text:
        return None

    floatish = re.fullmatch(r'(\d+)\.0+', text)
    if floatish:
        return floatish.group(1)
    return text


def _is_header_row(row_type: str, second_cell: Optional[str]) -> bool:
    """Detect header rows for FK/LT/OF blocks."""
    if row_type == 'FK' and second_cell == FK_HEADER_TOKEN:
        return True
    if row_type == 'OF' and second_cell == OF_HEADER_TOKEN:
        return True
    if row_type == 'LT' and second_cell == LT_HEADER_TOKEN:
        return True
    return False


def _resolve_config_path(config_arg: str) -> Path:
    """Locate the config file relative to common repo/docker locations."""
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

    raise RuntimeError(f"Config file '{config_arg}' not found. Searched: {candidates}")


def _load_config(config_arg: str) -> Tuple[Dict[str, Any], Path]:
    """Load the pipeline config JSON."""
    path = _resolve_config_path(config_arg)
    try:
        return json.loads(path.read_text(encoding='utf-8')), path
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"Failed to read config from {path}: {exc}") from exc


def _ensure_temp_staging_columns(conn) -> None:
    """Add buyer columns if they are missing."""
    alter_sql = """
    ALTER TABLE public."temporaryStaging"
        ADD COLUMN IF NOT EXISTS buyer_name_raw text,
        ADD COLUMN IF NOT EXISTS buyer_match_confidence double precision;
    """
    with conn.cursor() as cur:
        cur.execute(alter_sql)
    conn.commit()


def _truncate_staging(conn) -> int:
    """Truncate temporaryStaging when it already contains data."""
    with conn.cursor() as cur:
        cur.execute('SELECT COUNT(*) FROM public."temporaryStaging"')
        existing = cur.fetchone()[0] or 0
        if existing:
            cur.execute('TRUNCATE TABLE public."temporaryStaging"')
    conn.commit()
    return int(existing)


def _register_job_config(conn, job_id: str, config_name: str, seller_id: Optional[str]) -> None:
    """Register the job/config mapping for downstream stages."""
    insert_sql = """
    INSERT INTO public.job_config (job_id, config_name, seller_id)
    VALUES (%s, %s, %s)
    ON CONFLICT (job_id)
    DO UPDATE SET config_name = EXCLUDED.config_name, seller_id = EXCLUDED.seller_id
    """
    with conn.cursor() as cur:
        cur.execute(insert_sql, (job_id, config_name, seller_id))
    conn.commit()


def _build_staging_row(
    current_fk: Dict[str, Optional[str]],
    of_row: Sequence[Any],
    config_values: Dict[str, str],
    job_id: str,
) -> Optional[Dict[str, Any]]:
    """Create a staging row dict from FK context + OF row."""
    invoice = current_fk.get('invoice')
    buyer_name_raw = current_fk.get('buyer_name_raw')
    if not invoice:
        return None

    item_description = _clean_str(of_row[2])
    if not item_description:
        return None

    qty = _parse_decimal(of_row[4])
    unit_price = _parse_decimal(of_row[3])
    amount = _parse_decimal(of_row[5])

    return {
        'job_id': job_id,
        'buyer_name_raw': buyer_name_raw,
        'buyer_party_id': None,
        'invoice': invoice,
        'ship_date': current_fk.get('ship_date'),
        'item_description': item_description,
        'input_quantity': qty,
        'input_uom': config_values['input_uom'],
        'total_kg': qty,
        'unit_price': unit_price,
        'amount': amount,
        'currency': config_values['currency'],
        'hs_code': config_values['hs_code'],
        'buyer_match_confidence': None,
    }


def _parse_stahl_excel(
    excel_path: str,
    config_values: Dict[str, str],
    job_id: str,
) -> Tuple[List[Dict[str, Any]], int, int]:
    """Parse FK/OF rows and return staging rows plus counts."""
    df = pd.read_excel(excel_path, header=None, dtype=object)
    df = df.where(pd.notna(df), None)

    staging_rows: List[Dict[str, Any]] = []
    current_fk: Dict[str, Optional[str]] = {}
    invoice_numbers = set()
    buyer_names = set()

    for row in df.itertuples(index=False, name=None):
        row_type = _clean_str(row[0])
        if not row_type:
            continue
        row_type = row_type.upper()
        second_cell = _clean_str(row[1])

        if _is_header_row(row_type, second_cell):
            continue

        if row_type == 'FK':
            invoice = _normalize_invoice(row[18])
            ship_date = _parse_ship_date(row[6])
            buyer_name_raw = _clean_str(row[8])
            current_fk = {
                'invoice': invoice,
                'ship_date': ship_date,
                'buyer_name_raw': buyer_name_raw,
            }
            if invoice:
                invoice_numbers.add(invoice)
            if buyer_name_raw:
                buyer_names.add(buyer_name_raw.strip().lower())
        elif row_type == 'OF':
            if not current_fk:
                print("  ⚠️  Encountered OF row without FK context - skipping")
                continue
            staging_row = _build_staging_row(current_fk, row, config_values, job_id)
            if staging_row:
                staging_rows.append(staging_row)
        else:
            # LT or other rows are not needed for staging
            continue

    return staging_rows, len(invoice_numbers), len(buyer_names)


def _insert_rows(conn, rows: List[Dict[str, Any]]) -> int:
    """Insert prepared rows into public.temporaryStaging."""
    if not rows:
        return 0

    insert_sql = sql.SQL(
        'INSERT INTO public.{} ({}) VALUES ({})'
    ).format(
        sql.Identifier(STAGING_TABLE),
        sql.SQL(', ').join(map(sql.Identifier, STAGING_COLUMNS)),
        sql.SQL(', ').join(sql.Placeholder() * len(STAGING_COLUMNS)),
    )

    payload = []
    for row in rows:
        payload.append(tuple(row.get(col) for col in STAGING_COLUMNS))

    with conn.cursor() as cur:
        execute_batch(cur, insert_sql, payload, page_size=1000)
    conn.commit()
    return len(rows)


def main() -> None:
    import time

    parser = argparse.ArgumentParser(
        description='Import Stahl Excel into public."temporaryStaging"'
    )
    parser.add_argument(
        '--config',
        required=True,
        help='Path to invoice_pt_stahl.json (or resolvable name)',
    )
    parser.add_argument(
        'excel_path',
        help='Path to Stahl Excel file (e.g., services/xls2sql/training/stahl/stahl.xlsx)',
    )
    args = parser.parse_args()

    script_start = time.time()

    if not os.path.exists(args.excel_path):
        print(f"❌ Error: File not found: {args.excel_path}")
        sys.exit(1)

    try:
        # Generate unique job_id
        job_id = str(uuid.uuid4())
        config_data, config_path = _load_config(args.config)
        db_config = _get_db_config()
    except Exception as err:  # noqa: BLE001
        print(f"❌ {err}")
        sys.exit(1)

    # Pull mapping values from config
    config_values = {
        'input_uom': config_data.get('uom', {}).get('alias'),
        'currency': config_data.get('currency', {}).get('code'),
        'hs_code': str(config_data.get('hs', {}).get('code'))
        if config_data.get('hs', {}).get('code') is not None
        else None,
    }

    if not all(config_values.values()):
        print("❌ Config missing required keys: uom.alias, currency.code, hs.code")
        sys.exit(1)

    print("=" * 70)
    print("  STAHL EXCEL IMPORT TO POSTGRESQL")
    print("=" * 70)
    print(f"Job ID       : {job_id}")
    print(f"Config       : {config_path}")
    print(f"Source file  : {args.excel_path}")
    print()

    try:
        conn = psycopg2.connect(**db_config)
    except Exception as err:  # noqa: BLE001
        print(f"❌ Failed to connect to PostgreSQL: {err}")
        sys.exit(1)

    try:
        _ensure_temp_staging_columns(conn)
        existing_rows = _truncate_staging(conn)
        if existing_rows:
            print(f"⌫ Cleared {existing_rows} existing row(s) from public.\"{STAGING_TABLE}\"")

        _register_job_config(
            conn,
            job_id,
            config_path.name,
            config_data.get('seller', {}).get('id'),
        )
        seller_note = config_data.get('seller', {}).get('id')
        seller_suffix = f" (seller {seller_note})" if seller_note else ""
        print(f"✓ Registered job {job_id} with config {config_path.name}{seller_suffix}")

        print("⏱️  Reading Excel and building staging rows...")
        rows, invoice_count, buyer_count = _parse_stahl_excel(
            args.excel_path,
            config_values,
            job_id,
        )

        inserted = _insert_rows(conn, rows)
        elapsed_ms = (time.time() - script_start) * 1000

        print(f"✓ Parsed {len(rows)} line item(s) from Excel")
        print("=" * 70)
        print("  IMPORT SUMMARY")
        print("=" * 70)
        print(f"✓ Job ID:            {job_id}")
        print(f"✓ Config:            {config_path.name}")
        print(f"✓ Invoices parsed:   {invoice_count}")
        print(f"✓ Buyer names:       {buyer_count} (non-empty)")
        print(f"✓ Rows inserted:     {inserted}")
        print(f"⏱️  TOTAL SCRIPT TIME: {elapsed_ms:.0f}ms")
        print("\n✅ Import completed successfully!")
    except Exception as err:  # noqa: BLE001
        elapsed_ms = (time.time() - script_start) * 1000
        print(f"\n❌ Error during import: {err}")
        print(f"⏱️  Failed after {elapsed_ms:.0f}ms")
        import traceback

        traceback.print_exc()
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
