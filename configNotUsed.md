Config Usage Audit for services/pdf2json/config/invoice_simon_v15.json

Unused (not referenced by code)
- header_block_margin: Not read by any stage.
- stage5.column_types.currency_columns: Not referenced in Stage 5 or others.
- stage5.date_formats.output_format: Present but Stage 5 currently always outputs YYYY-MM-DD regardless of this setting.
- name, version: Metadata only; not used in pipeline logic.

Used (where and how)
- header_aliases: Used by Stage 4 (services/pdf2json/stages/s04_camelot_grid_configV12.py) to map header cell text to canonical families.
- totals_keywords: Used by Stage 4 to stop row capture when totals-like lines appear.
- camelot.flavor_order: Used by Stage 4 to try Camelot flavors per page (lattice→stream).
- camelot.line_scale: Used by Stage 4 when reading with lattice flavor.
- camelot.line_scale_stream: Used by Stage 4 when reading with stream flavor.
- stop_after_totals: Used by Stage 4 to limit rows below header before totals.
- stage5.column_types.by_family: Used by Stage 5 (services/pdf2json/stages/s05_normalize_cells.py) to decide normalization per family (number/integer/text/date).
- stage5.column_types.by_position: Used by Stage 5 to override type by absolute column index.
- stage5.column_types.date_columns: Used by Stage 5 to choose which columns are parsed as dates.
- stage5.number_format.decimal/thousands/allow_parens: Used by Stage 5 _norm_number to normalize numeric strings.
- stage5.date_formats.input_patterns: Used by Stage 5 _norm_date (token patterns and regex patterns).
- stage5.date_formats.century_cutoff: Used by Stage 5 _norm_date to expand 2-digit years.
- currency_hints: Used by Stage 6 (s06_line_items_from_cellsV2.py) to strip currency tokens from numbers; also used by Stage 7 V2 to detect currency.
- uom_hints: Used by Stage 6 (s06_line_items_from_cellsV2.py) to infer default UOM from header.
- stage6.index_fallback: Used by Stage 6 V2 to map header cell names (e.g., COL5 → DESC) when aliasing fails.
- stage6.required_families: Used by Stage 6 V2 to decide if a row is an item (id_field + must_have_any).
- stage6.row_filters.drop_if_matches: Used by Stage 6 V2 to drop subtotal/total/terms rows.
- stage6.number_format.decimal/thousands/allow_parens: Used by Stage 6 V2 numeric parsing.
- stage6.derivation.fill_*: Used by Stage 6 V2 to fill missing amount or unit_price from the other fields.
- stage6.rounding.money_decimals: Used by Stage 6 V2 to round monetary values when emitting floats.
- stage7.header_rows_to_scan: Used by Stage 7 V2 to bound header scanning window.
- stage7.seller_from_header_cols: Used by Stage 7 V2 to compose seller name from header columns.
- stage7.invoice_no_patterns: Used by Stage 7 V2 to extract invoice number.
- stage7.date_patterns: Used by Stage 7 V2 to extract invoice date.
- stage7.po_patterns: Used by Stage 7 V2 to extract PO reference, if present.
- stage7.customer_code_patterns: Used by Stage 7 V2 to extract buyer/customer code.
- stage7.payment_terms.label_contains/include_next_n_rows: Used by Stage 7 V2 to extract payment terms block.
- stage7.buyer_block.start_label_contains/stop_when_contains/max_lines: Used by Stage 7 V2 to extract buyer block lines.
- stage7.currency_order: Used by Stage 7 V2 (with currency_hints) to determine currency preference.

Notes
- Text reconstruction rules now come solely from services/pdf2json/common/common-words.json (case‑preserving de‑spacing) plus generic spacing/hyphen normalization in Stage 5. The `stage5.text_reconstruction` block has been removed from the layout config.
