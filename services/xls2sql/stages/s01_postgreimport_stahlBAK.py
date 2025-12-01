#!/usr/bin/env python3
"""
Import a Stahl Excel workbook into a freshly created PostgreSQL staging table.

Usage:
    python services/xls2sql/stages/s01_postgreimport_stahl.py path/to/stahl.xlsx
"""

import argparse
import os
import re
import secrets
import sys
from typing import Dict, List, Tuple

import pandas as pd
import psycopg2
from psycopg2 import errors, sql
from psycopg2.extras import execute_batch


# Source columns expected in the Excel file
REQUIRED_SOURCE_COLUMNS = [
    "FK",
    "KD_JENIS_TRANSAKSI",
    "FG_PENGGANTI",
    "NOMOR_FAKTUR",
    "MASA_PAJAK",
    "TAHUN_PAJAK",
    "TANGGAL_FAKTUR",
    "NPWP",
    "NAMA",
    "ALAMAT_LENGKAP",
    "JUMLAH_DPP",
    "JUMLAH_PPN",
    "JUMLAH_PPNBM",
    "ID_KETERANGAN_TAMBAHAN",
    "FG_UANG_MUKA",
    "UANG_MUKA_DPP",
    "UANG_MUKA_PPN",
    "UANG_MUKA_PPNBM",
    "REFERENSI",
    "CANCELLED",
]

# Destination columns in the staging table
DESTINATION_COLUMNS = [f"Col{i}" for i in range(1, 21)]

# Mapping from Excel headers to staging columns
SOURCE_TO_DEST = {
    "FK": "Col1",
    "KD_JENIS_TRANSAKSI": "Col2",
    "FG_PENGGANTI": "Col3",
    "NOMOR_FAKTUR": "Col4",
    "MASA_PAJAK": "Col5",
    "TAHUN_PAJAK": "Col6",
    "TANGGAL_FAKTUR": "Col7",
    "NPWP": "Col8",
    "NAMA": "Col9",
    "ALAMAT_LENGKAP": "Col10",
    "JUMLAH_DPP": "Col11",
    "JUMLAH_PPN": "Col12",
    "JUMLAH_PPNBM": "Col13",
    "ID_KETERANGAN_TAMBAHAN": "Col14",
    "FG_UANG_MUKA": "Col15",
    "UANG_MUKA_DPP": "Col16",
    "UANG_MUKA_PPN": "Col17",
    "UANG_MUKA_PPNBM": "Col18",
    "REFERENSI": "Col19",
    "CANCELLED": "Col20",
}


def get_db_config() -> Dict[str, str]:
    """Fetch database connection settings from the environment."""
    required_vars = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"]
    missing = [var for var in required_vars if not os.getenv(var)]
    if missing:
        raise RuntimeError(
            f"Missing required database environment variables: {', '.join(missing)}"
        )
    return {
        "host": os.getenv("DB_HOST"),
        "port": os.getenv("DB_PORT"),
        "database": os.getenv("DB_NAME"),
        "user": os.getenv("DB_USER"),
        "password": os.getenv("DB_PASSWORD"),
    }


def normalize_header(name: str) -> str:
    """Normalize header names for matching (remove non-alphanumerics, upper-case)."""
    return re.sub(r"[^A-Za-z0-9]", "", str(name)).upper()


def build_header_mapping(columns: List[str]) -> Tuple[Dict[str, str], List[str]]:
    """
    Build a map from required source headers to the actual column names found.

    Returns:
        (mapping, missing_headers)
    """
    normalized_lookup = {}
    for col in columns:
        norm = normalize_header(col)
        if norm not in normalized_lookup:
            normalized_lookup[norm] = col

    mapping = {}
    missing = []
    for required in REQUIRED_SOURCE_COLUMNS:
        norm_required = normalize_header(required)
        actual = normalized_lookup.get(norm_required)
        if actual:
            mapping[required] = actual
        else:
            missing.append(required)

    return mapping, missing


def generate_table_name() -> str:
    """Generate a random temporary staging table name."""
    random_suffix = f"{secrets.randbelow(1_000_000):06d}"
    return f"temporaryStaging{random_suffix}"


def create_staging_table(conn, table_name: str) -> None:
    """Create the staging table with the required columns."""
    column_defs = [
        sql.SQL("{} TEXT").format(sql.Identifier(col)) for col in DESTINATION_COLUMNS
    ]
    create_sql = sql.SQL('CREATE TABLE public.{} ({})').format(
        sql.Identifier(table_name),
        sql.SQL(", ").join(column_defs),
    )
    with conn.cursor() as cur:
        cur.execute(create_sql)
    conn.commit()


def ensure_table_created(conn) -> str:
    """Create a unique staging table, retrying if a collision occurs."""
    attempts = 0
    while attempts < 5:
        table_name = generate_table_name()
        try:
            create_staging_table(conn, table_name)
            return table_name
        except errors.DuplicateTable:
            conn.rollback()
            attempts += 1
    raise RuntimeError("Failed to create a unique staging table after multiple attempts.")


def load_and_prepare_data(file_path: str) -> pd.DataFrame:
    """Load the Excel file, validate headers, and return a trimmed dataframe."""
    df = pd.read_excel(file_path)
    header_map, missing = build_header_mapping(df.columns.tolist())
    if missing:
        raise RuntimeError(
            f"Excel file is missing required column(s): {', '.join(missing)}"
        )

    # Select and rename required columns only
    selected_columns = [header_map[src] for src in REQUIRED_SOURCE_COLUMNS]
    df_selected = df[selected_columns].copy()
    rename_map = {header_map[src]: dest for src, dest in SOURCE_TO_DEST.items()}
    df_selected = df_selected.rename(columns=rename_map)

    # Normalize values: convert NaN to None and coerce everything to string before insert
    for col in df_selected.columns:
        df_selected[col] = df_selected[col].apply(
            lambda val: None if pd.isna(val) else str(val)
        )

    return df_selected


def insert_rows(conn, table_name: str, df: pd.DataFrame) -> int:
    """Insert dataframe rows into the staging table."""
    if df.empty:
        return 0

    insert_sql = sql.SQL("INSERT INTO public.{} ({}) VALUES ({})").format(
        sql.Identifier(table_name),
        sql.SQL(", ").join(map(sql.Identifier, DESTINATION_COLUMNS)),
        sql.SQL(", ").join(sql.Placeholder() * len(DESTINATION_COLUMNS)),
    )

    rows = [
        tuple(row.get(col) for col in DESTINATION_COLUMNS)
        for _, row in df.iterrows()
    ]

    with conn.cursor() as cur:
        execute_batch(cur, insert_sql, rows, page_size=1000)
    conn.commit()
    return len(rows)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Import Stahl Excel into a temporary PostgreSQL staging table."
    )
    parser.add_argument(
        "excel_path",
        help="Path to Stahl Excel file (e.g., services/xls2sql/training/stahl/stahl.xlsx)",
    )
    args = parser.parse_args()

    if not os.path.exists(args.excel_path):
        print(f"❌ Error: File not found: {args.excel_path}")
        sys.exit(1)

    print("=" * 70)
    print("  STAHL EXCEL IMPORT TO POSTGRESQL")
    print("=" * 70)
    print(f"Source file : {args.excel_path}")

    try:
        db_config = get_db_config()
    except RuntimeError as err:
        print(f"❌ {err}")
        sys.exit(1)

    try:
        conn = psycopg2.connect(**db_config)
    except Exception as err:
        print(f"❌ Failed to connect to PostgreSQL: {err}")
        sys.exit(1)

    try:
        table_name = ensure_table_created(conn)
        print(f"✓ Created staging table: {table_name}")

        df = load_and_prepare_data(args.excel_path)
        inserted = insert_rows(conn, table_name, df)

        print("=" * 70)
        print("  IMPORT SUMMARY")
        print("=" * 70)
        print(f"✓ Table name   : {table_name}")
        print(f"✓ Rows inserted: {inserted}")
        print(f"✓ Columns used : {len(DESTINATION_COLUMNS)} (Col1-Col20)")
        print("\n✅ Import completed successfully!")
    except Exception as err:
        print(f"\n❌ Error during import: {err}")
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
