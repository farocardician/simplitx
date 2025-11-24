#!/usr/bin/env python3
"""
Import script for Sensient Excel data to PostgreSQL temporaryStaging table.

This script:
1. Reads an Excel file with multiple sheets
2. Resolves buyer_party_id from the "Customer Group" column in each sheet
3. Imports selected columns into temporaryStaging table
4. Generates a unique batch_id for the import run

Sheet-name agnostic: Uses "Customer Group" column from data to identify buyers.
"""

import sys
import uuid
import os
from typing import Optional, Dict, List, Tuple
from collections import Counter
import pandas as pd
import psycopg2
from psycopg2 import sql
from psycopg2.extras import execute_batch
from fuzzywuzzy import fuzz, process


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

# Fuzzy match threshold
FUZZY_THRESHOLD = 70


def get_db_connection():
    """Create and return a database connection."""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        return conn
    except Exception as e:
        print(f"❌ Error connecting to database: {e}")
        sys.exit(1)


def get_all_parties(conn) -> Dict[str, str]:
    """
    Retrieve all parties from database and return as dict {name: id}.
    Names are normalized to lowercase for matching.
    IDs are UUIDs stored as strings.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT id, display_name FROM public.parties WHERE deleted_at IS NULL")
        parties = cur.fetchall()
        return {name.lower().strip(): str(party_id) for party_id, name in parties}


def resolve_buyer_party_id(
    customer_name: str,
    parties_dict: Dict[str, str],
    fuzzy_threshold: int = FUZZY_THRESHOLD
) -> Optional[str]:
    """
    Resolve buyer_party_id from customer name.

    First tries exact match (case-insensitive).
    If not found, tries fuzzy matching.

    Args:
        customer_name: Customer name from "Customer Group" column
        parties_dict: Dictionary of {party_name: party_id}
        fuzzy_threshold: Minimum fuzzy match score (0-100)

    Returns:
        party_id if found, None otherwise
    """
    if pd.isna(customer_name) or not customer_name:
        return None

    normalized_name = str(customer_name).lower().strip()

    # Try exact match first
    if normalized_name in parties_dict:
        return parties_dict[normalized_name]

    # Try fuzzy matching
    party_names = list(parties_dict.keys())
    best_match = process.extractOne(
        normalized_name,
        party_names,
        scorer=fuzz.ratio
    )

    if best_match and best_match[1] >= fuzzy_threshold:
        matched_name = best_match[0]
        match_score = best_match[1]
        party_id = parties_dict[matched_name]
        return party_id, matched_name, match_score

    return None


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
    - Keep Customer Group for later buyer resolution
    """
    # Select only columns that exist in the dataframe
    available_columns = [col for col in ALL_IMPORT_COLUMNS if col in df.columns]
    df_normalized = df[available_columns + ['Customer Group']].copy()

    # Rename import columns
    df_normalized = df_normalized.rename(columns=COLUMN_MAPPING)

    # Add missing optional columns as NULL
    for col in OPTIONAL_COLUMNS:
        if col not in available_columns:
            db_col_name = COLUMN_MAPPING[col]
            df_normalized[db_col_name] = None

    # Add batch_id
    df_normalized['batch_id'] = batch_id

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


def process_sheet_by_customer(
    df: pd.DataFrame,
    sheet_name: str,
    parties_dict: Dict[str, str],
    batch_id: str,
    conn
) -> Tuple[int, int, int]:
    """
    Process a sheet by grouping rows by Customer Group and resolving each buyer.

    Returns:
        Tuple of (customers_processed, customers_skipped, total_rows_inserted)
    """
    customers_processed = 0
    customers_skipped = 0
    total_rows_inserted = 0

    # Remove rows with null Customer Group first
    df_with_customer = df[df['Customer Group'].notna()].copy()

    if df_with_customer.empty:
        print(f"  ⚠️  No rows with valid Customer Group found")
        return 0, 0, 0

    # Group by Customer Group
    customer_groups = df_with_customer.groupby('Customer Group')

    print(f"  📊 Found {len(customer_groups)} unique customer(s) in sheet")

    for customer_name, group_df in customer_groups:
        # Skip null/empty customer names
        if pd.isna(customer_name) or not str(customer_name).strip():
            print(f"    ⚠️  Skipping {len(group_df)} rows with empty Customer Group")
            customers_skipped += 1
            continue

        # Resolve buyer_party_id
        result = resolve_buyer_party_id(customer_name, parties_dict)

        if result is None:
            print(f"    ⚠️  Could not resolve buyer for '{customer_name}' - Skipping {len(group_df)} rows")
            customers_skipped += 1
            continue

        # Handle tuple return from fuzzy match
        if isinstance(result, tuple):
            buyer_party_id, matched_name, match_score = result
            print(f"    ✓ '{customer_name}' → '{matched_name}' (fuzzy: {match_score}%) - {len(group_df)} rows")
        else:
            buyer_party_id = result
            print(f"    ✓ '{customer_name}' (exact match) - {len(group_df)} rows")

        # Add buyer_party_id to the group
        group_df = group_df.copy()
        group_df['buyer_party_id'] = buyer_party_id

        # Insert data for this customer
        rows_inserted = insert_data(conn, group_df)
        total_rows_inserted += rows_inserted
        customers_processed += 1

    return customers_processed, customers_skipped, total_rows_inserted


def process_excel_file(file_path: str) -> Tuple[str, int, int, int, int]:
    """
    Main function to process Excel file and import to database.

    Returns:
        Tuple of (batch_id, sheets_processed, sheets_skipped, total_customers, total_rows)
    """
    # Generate unique batch_id
    batch_id = str(uuid.uuid4())

    # Connect to database
    conn = get_db_connection()

    try:
        # Get all parties from database
        print("📊 Loading parties from database...")
        parties_dict = get_all_parties(conn)
        print(f"   Found {len(parties_dict)} parties in database\n")

        # Load Excel file
        print(f"📂 Loading Excel file: {file_path}")
        xl_file = pd.ExcelFile(file_path)
        all_sheets = xl_file.sheet_names
        print(f"   Found {len(all_sheets)} sheets\n")

        # Statistics
        sheets_processed = 0
        sheets_skipped = 0
        total_customers_processed = 0
        total_rows_inserted = 0

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

            # Process by customer groups
            customers_proc, customers_skip, rows_inserted = process_sheet_by_customer(
                df_normalized, sheet_name, parties_dict, batch_id, conn
            )

            if customers_proc > 0:
                sheets_processed += 1
                total_customers_processed += customers_proc
                total_rows_inserted += rows_inserted
                print(f"  ✓ Sheet completed: {customers_proc} buyer(s), {rows_inserted} rows inserted\n")
            else:
                sheets_skipped += 1
                print(f"  ⚠️  No valid buyers found in sheet - Skipped\n")

        return batch_id, sheets_processed, sheets_skipped, total_customers_processed, total_rows_inserted

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
        batch_id, sheets_processed, sheets_skipped, total_customers, total_rows = process_excel_file(file_path)

        # Print summary
        print("=" * 70)
        print("  IMPORT SUMMARY")
        print("=" * 70)
        print(f"✓ Batch ID:          {batch_id}")
        print(f"✓ Sheets processed:  {sheets_processed}")
        print(f"✓ Sheets skipped:    {sheets_skipped}")
        print(f"✓ Total buyers:      {total_customers}")
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
