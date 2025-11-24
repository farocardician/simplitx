#!/usr/bin/env python3
"""
Stage s01 - import only.

Responsibility:
- Read Sensient Excel workbooks and load rows into public."temporaryStaging".
- Do not resolve buyers; simply capture the raw buyer name from "Customer Group".
- Stamp every inserted row with a batch_id so downstream steps (s02) can work per batch.
"""

import sys
import uuid
import os
from typing import List, Tuple
import pandas as pd
import psycopg2
from psycopg2 import sql
from psycopg2.extras import execute_batch


# Database connection parameters from environment
DB_CONFIG = {
    'host': os.getenv('DB_HOST', 'localhost'),
    'port': os.getenv('DB_PORT', '5432'),
    'database': os.getenv('DB_NAME', 'postgres'),
    'user': os.getenv('DB_USER', 'postgres'),
    'password': os.getenv('DB_PASSWORD', ''),
}

# Required columns from Excel
REQUIRED_COLUMNS = [
    'Invoice',
    'Ship Date',
    'Item Description',
    'Input Quantity',
    'Input UOM',
    'Total KG',
    'Unit Price',
    'Amount',
    'Currency',
]

# Optional columns (won't cause sheet to be skipped if missing)
OPTIONAL_COLUMNS = ['HS-Code']

# All columns to attempt to import
ALL_IMPORT_COLUMNS = REQUIRED_COLUMNS + OPTIONAL_COLUMNS

# Mapping from Excel columns to database columns
COLUMN_MAPPING = {
    'Invoice': 'invoice',
    'Ship Date': 'ship_date',
    'Item Description': 'item_description',
    'Input Quantity': 'input_quantity',
    'Input UOM': 'input_uom',
    'Total KG': 'total_kg',
    'Unit Price': 'unit_price',
    'Amount': 'amount',
    'Currency': 'currency',
    'HS-Code': 'hs_code',
}

# Sheets to skip (non-data sheets)
SKIP_SHEETS = ['Sheet1', 'Data Seller', 'Sheet4', 'Sheet1 (1)', 'Rittal', 'Simon', 'Silesia']


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
        ADD COLUMN IF NOT EXISTS buyer_name text,
        ADD COLUMN IF NOT EXISTS buyer_match_confidence double precision;
    """
    with conn.cursor() as cur:
        cur.execute(alter_sql)
    conn.commit()


def check_required_columns(df: pd.DataFrame, sheet_name: str) -> Tuple[bool, List[str]]:
    """
    Check if all required columns are present in the dataframe.

    Returns:
        Tuple of (success: bool, missing_optional: List[str])
    """
    # Check for Customer Group column (critical for buyer identification)
    if 'Customer Group' not in df.columns:
        print(f"  ⚠️  Missing 'Customer Group' column - cannot identify buyers")
        return False, []

    # Check required columns
    missing_required = [col for col in REQUIRED_COLUMNS if col not in df.columns]
    if missing_required:
        print(f"  ⚠️  Missing required columns: {missing_required}")
        return False, []

    # Check optional columns
    missing_optional = [col for col in OPTIONAL_COLUMNS if col not in df.columns]
    if missing_optional:
        print(f"  ℹ️  Missing optional columns: {missing_optional} (will be set to NULL)")

    return True, missing_optional


def normalize_dataframe(df: pd.DataFrame, batch_id: str) -> pd.DataFrame:
    """
    Normalize dataframe for insertion:
    - Select only required columns (including optional ones if present)
    - Rename columns to snake_case
    - Add batch_id
    - Convert data types
    - Keep buyer_name from Customer Group for later buyer resolution
    """
    # Select only columns that exist in the dataframe
    available_columns = [col for col in ALL_IMPORT_COLUMNS if col in df.columns]
    df_normalized = df[available_columns + ['Customer Group']].copy()

    # Rename import columns
    df_normalized = df_normalized.rename(columns=COLUMN_MAPPING)

    # Capture raw buyer name
    df_normalized = df_normalized.rename(columns={'Customer Group': 'buyer_name'})

    # Add missing optional columns as NULL
    for col in OPTIONAL_COLUMNS:
        if col not in available_columns:
            db_col_name = COLUMN_MAPPING[col]
            df_normalized[db_col_name] = None

    # Add batch_id
    df_normalized['batch_id'] = batch_id

    # Buyer fields are handled in s02; set placeholders
    df_normalized['buyer_party_id'] = None
    df_normalized['buyer_match_confidence'] = None

    # Convert ship_date to string (handle various date formats)
    if 'ship_date' in df_normalized.columns:
        df_normalized['ship_date'] = df_normalized['ship_date'].astype(str)

    # Convert invoice to string
    if 'invoice' in df_normalized.columns:
        df_normalized['invoice'] = df_normalized['invoice'].astype(str)

    # Ensure numeric columns are properly typed
    numeric_columns = ['input_quantity', 'total_kg', 'unit_price', 'amount']
    for col in numeric_columns:
        if col in df_normalized.columns:
            df_normalized[col] = pd.to_numeric(df_normalized[col], errors='coerce')

    # Remove completely empty rows
    df_normalized = df_normalized.dropna(how='all')

    return df_normalized


def insert_data(conn, df: pd.DataFrame) -> int:
    """
    Insert dataframe into temporaryStaging table using batch insert.

    Returns:
        Number of rows inserted
    """
    if df.empty:
        return 0

    # Prepare column list (excluding Customer Group which is not in DB)
    columns = [
        'batch_id',
        'buyer_name',
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

    # Convert dataframe to list of tuples
    data = []
    for _, row in df.iterrows():
        values = tuple(
            None if pd.isna(row.get(col)) else row.get(col)
            for col in columns
        )
        data.append(values)

    # Prepare SQL insert statement
    insert_sql = sql.SQL(
        "INSERT INTO public.\"temporaryStaging\" ({}) VALUES ({})"
    ).format(
        sql.SQL(', ').join(map(sql.Identifier, columns)),
        sql.SQL(', ').join(sql.Placeholder() * len(columns))
    )

    # Execute batch insert
    with conn.cursor() as cur:
        execute_batch(cur, insert_sql, data, page_size=1000)

    conn.commit()
    return len(data)


def process_excel_file(file_path: str) -> Tuple[str, int, int, int, int]:
    """
    Main function to process Excel file and import to database.

    Returns:
        Tuple of (batch_id, sheets_processed, sheets_skipped, unique_buyers, total_rows)
    """
    # Generate unique batch_id
    batch_id = str(uuid.uuid4())

    # Connect to database
    conn = get_db_connection()
    ensure_temp_staging_columns(conn)

    try:
        # Load Excel file
        print(f"📂 Loading Excel file: {file_path}")
        xl_file = pd.ExcelFile(file_path)
        all_sheets = xl_file.sheet_names
        print(f"   Found {len(all_sheets)} sheets\n")

        # Statistics
        sheets_processed = 0
        sheets_skipped = 0
        total_rows_inserted = 0
        buyer_names_seen = set()

        # Process each sheet
        for sheet_name in all_sheets:
            print(f"📄 Processing sheet: '{sheet_name}'")

            # Skip non-data sheets
            if sheet_name in SKIP_SHEETS:
                print(f"  ⏭️  Skipped (in SKIP_SHEETS list)\n")
                sheets_skipped += 1
                continue

            # Read sheet (skip first 5 rows which are headers/formatting)
            try:
                df = pd.read_excel(file_path, sheet_name=sheet_name, skiprows=5)
            except Exception as e:
                print(f"  ❌ Error reading sheet: {e}\n")
                sheets_skipped += 1
                continue

            # Check required columns
            has_required, missing_optional = check_required_columns(df, sheet_name)
            if not has_required:
                sheets_skipped += 1
                print()
                continue

            # Normalize dataframe
            df_normalized = normalize_dataframe(df, batch_id)

            if df_normalized.empty:
                print(f"  ⚠️  No data rows found after normalization - Skipping\n")
                sheets_skipped += 1
                continue

            # Track buyer names for summary (non-empty only)
            sheet_buyers = {
                str(name).strip().lower()
                for name in df_normalized['buyer_name'].dropna()
                if str(name).strip()
            }
            buyer_names_seen.update(sheet_buyers)

            # Insert data for this sheet
            rows_inserted = insert_data(conn, df_normalized)
            total_rows_inserted += rows_inserted
            sheets_processed += 1
            print(f"  ✓ Sheet completed: {rows_inserted} rows inserted\n")

        return batch_id, sheets_processed, sheets_skipped, len(buyer_names_seen), total_rows_inserted

    finally:
        conn.close()


def main():
    """Main entry point."""
    # Check command line arguments
    if len(sys.argv) < 2:
        print("Usage: python s01_postgreimport_sensient.py <excel_file_path>")
        print("\nExample:")
        print("  python s01_postgreimport_sensient.py ./services/pdf2json/training/sensient/sensient.xlsx")
        sys.exit(1)

    file_path = sys.argv[1]

    # Check if file exists
    if not os.path.exists(file_path):
        print(f"❌ Error: File not found: {file_path}")
        sys.exit(1)

    print("=" * 70)
    print("  SENSIENT EXCEL IMPORT TO POSTGRESQL")
    print("=" * 70)
    print()

    # Process the file
    try:
        batch_id, sheets_processed, sheets_skipped, unique_buyers, total_rows = process_excel_file(file_path)

        # Print summary
        print("=" * 70)
        print("  IMPORT SUMMARY")
        print("=" * 70)
        print(f"✓ Batch ID:          {batch_id}")
        print(f"✓ Sheets processed:  {sheets_processed}")
        print(f"✓ Sheets skipped:    {sheets_skipped}")
        print(f"✓ Buyer names:       {unique_buyers} (non-empty)")
        print(f"✓ Total rows:        {total_rows}")
        print("=" * 70)
        print("\n✅ Import completed successfully!")

    except Exception as e:
        print(f"\n❌ Error during import: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
