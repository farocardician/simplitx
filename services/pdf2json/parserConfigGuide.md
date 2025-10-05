# PT Simon Elektrik Parser Config Guide

This guide explains how to understand and adjust the template configuration that drives Stage 10 (`s10_parser.py`). The file lives at `services/pdf2json/config/s10_invoice_simon_parser_v1.json`. Every section below mirrors a top-level key in that JSON document.

The goal: keep the parser template-agnostic. Instead of editing Python, you tweak this JSON so Stage 10 knows how to interpret header values, line items, and totals for PT Simon invoices.

## 1. Metadata

```json
"metadata": {
  "template": "PT Simon Elektrik-Indonesia (IDR, VAT 12%)",
  "money_rounding": 2
}
```

- `template`: Human-readable label that ends up in the Stage 10 manifest for traceability. Change this if you clone the config for another vendor/version.
- `money_rounding`: Number of decimal places Stage 10 uses whenever it formats money (via the `money()` helper). Use `2` for currencies that express cents; bump to `0` if the template only uses whole numbers, or `3+` for precision-heavy formats.

## 2. Defaults

```json
"defaults": {
  "currency": "IDR",
  "tax_label": "VAT"
}
```

- `currency`: Fallback used when earlier stages do not capture a currency. Set this to the typical currency code for the template.
- `tax_label`: The label applied to the `totals.tax_label` field. Adjust when the template uses another term (e.g. `GST` or `Sales Tax`).

## 3. Header Extraction

```json
"header": {
  "pages": [1],
  "search_row_limit": 25,
  "fields": {
    "invoice_number": { "match": "contains" },
    "invoice_date": { "match": "contains" }
  }
}
```

This section tells Stage 10 how to find the cell references for important header fields.

- `pages`: List of page indices (1-based) worth scanning. Expand to include more pages if the header might move.
- `search_row_limit`: Number of table rows inspected on each page. Increase if the invoice number creeps further down the document.
- `fields`: Per-field match rules. Each key matches a Stage 7 field, and the value describes how to recognize it in the cells table.
  - `match: "contains"` simply looks for the captured value as a substring. Other options available in `s10_parser.py` are `equals` or `regex`, with optional `case_sensitive`, `pattern`, or `alias`.
  - To point Stage 10 at an alternate back-reference key, add `"alias": "invoice_number"` etc.

Fine-tuning tip: If Stage 10 fails to locate the correct cell for `invoice_date`, try tightening the match with `"pattern": "^Invoice Date"` and `"match": "regex"`.

## 4. Line Items

```json
"items": {
  "min_columns": 8,
  "header_rows_can_hold_items": true,
  "key_field": "no",
  "fields": [ ... ]
}
```

Stage 10 uses this section to align JSON item fields with table columns.

- `min_columns`: Minimum number of cells required for a row to be treated as an item. Lower it if the template has fewer columns; raise it to avoid false positives.
- `header_rows_can_hold_items`: Some invoices repeat the first item in the table header area; keep `true` if you see that behavior, otherwise set to `false`.
- `key_field`: Field name used to identify rows. Typically the `no` (item index). For templates without a numeric key, switch to `description` or another unique column and update its `type` in `fields` accordingly.
- `fields`: Array mapping Stage 10 output names to table columns.
  - Each entry can specify `column` (0-based index), optional `type` (`int`, `decimal`, `string`), and optional `transform` (`money`, `int`, `string`).
  - Omitting `column` (as with `uom`) keeps the value Stage 7 already provided.

Fine-tuning tip: If the description occasionally overflows into the next row, consider adjusting earlier pipeline stages (Stage 6) to merge rows before they reach Stage 10.

## 5. Totals

```json
"totals": {
  "tax_label": "VAT",
  "fields": {
    "subtotal": ["printed.subtotal", "checks.subtotal.computed"],
    "tax_base": ["printed.tax_base", "computed.tax_base"],
    "tax_amount": ["printed.tax_amount", "computed.tax_amount"],
    "grand_total": ["printed.grand_total", "computed.grand_total"]
  }
}
```

This tells Stage 10 how to derive numeric totals when Stage 7 was incomplete.

- `tax_label`: Included for completeness, although the parser currently grabs it from `defaults.tax_label` when missing.
- `fields`: Each total lists ordered fallback sources. Stage 10 tests each path until it finds a non-null value.
  - Paths use dot notation: the first segment (`printed`, `computed`, or `checks`) references the matching object in `validation.json` Stage 8 output.
  - Subsequent segments walk into nested dicts. You can wrap an entry in `{ "source": "computed.grand_total" }` if you need to attach more metadata later.

Fine-tuning tip: If validation produces a custom computed field, add it as another fallback. Example: `"grand_total": ["printed.grand_total", "computed.invoice_total", "checks.totals.grand.total"]`.

## 6. Manifest

```json
"manifest": {
  "schema_template": "PT Simon Elektrik-Indonesia (IDR, VAT 12%)"
}
```

This label becomes part of the Stage 10 manifest output. Update it when the template meaningfully changes (new currency, tax rate, etc.) so downstream systems can distinguish versions.

## 7. Putting It Into Use

1. **Select the template.** The pipeline config (`services/config/invoice_pt_simon.json`) already points Stage 10 to `s10_invoice_simon_parser_v1.json`. If you duplicate the template, update that pipeline file to reference the new JSON.
2. **Run the pipeline.** Invoking the processor will load this configuration, assemble the final JSON, and stamp the manifest with the template metadata.
3. **Review results.** The output `final.json` contains the assembled document, while the manifest lists all inputs plus hashes.

## 8. Simple Use Case

You receive a PT Simon invoice variation where:

- The tax label is now `PPN`.
- Currency defaults to `USD`.
- The invoice date sometimes appears on page 2.

Steps to adjust:

1. In the `defaults` section, change `"currency": "USD"` and `"tax_label": "PPN"`.
2. Update `totals.tax_label` to `"PPN"` for consistency.
3. In the `header` section, set `"pages": [1, 2]` so Stage 10 searches both pages.
4. Run the pipeline again. Stage 10 will now fall back to USD/PPN when header extraction is missing and will scan page 2 for the invoice date.

No Python edits required—the configuration captures the differences.

## 9. Tips for New Templates

- Start by copying this JSON and renaming the file. Update `metadata.template` so manifests identify the new template.
- Adjust `items.fields` to match the new column order. Use the Stage 6 output (`*-items.json`) to understand the structure before tweaking columns.
- Leverage `header.fields` rules to make the back-references robust. Use `"case_sensitive": true` or regex patterns when literal matches fail.
- Ensure the `totals.fields` list matches the validation schema. Test with invoices where printed totals are present and others where they are missing.

By capturing template-specific behavior here, Stage 10 remains stable, reusable, and easier to maintain.
