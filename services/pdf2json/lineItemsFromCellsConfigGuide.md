# Line Items From Cells — Configuration Guide (v3)

This guide explains how to configure Stage 06: turning table cells into clean, reliable line items. You do not need to know how to code. Follow the steps, fill in a simple JSON file, and run the stage.

What this stage does
- Reads a table (cells) from the previous stage.
- Maps each column to a meaning (e.g., Quantity, Unit Price, Amount).
- Parses numbers and units, filters out totals/notes.
- Resolves Unit of Measure (UOM) from the row, header, or document.
- Applies discounts (row-level and document-level) with correct rounding.
- Validates amounts and outputs a clean items list.

---

## Quick start
1) Open the sample master schema at `services/pdf2json/config/MASTER_lineItemsFromCells.json` for reference.  
2) Create a vendor config JSON (e.g., `configs/vendor_acme.json`).  
3) Fill out the keys below (Fields, UOM, Discount, Defaults, etc.).  
4) Run the stage:

```bash
python s06_line_items_from_cellsV3.py \
  --input path/to/05-cells-normalized.json \
  --config configs/vendor_acme.json \
  --out out/06-items.json
```

If the result looks off, adjust the config and run again.

---

## The config file (overview)
Here is the shape of your config. You don’t need every option; start small.

```json
{
  "fields": { /* column mapping and parsing */ },
  "uom": { /* where to pick the unit (PCS, KG, etc.) */ },
  "discount": { /* how to find and split discounts */ },
  "currency_decimals": 2,
  "tolerances": { "amount_from_qty_price": { "abs": 0, "rel": 0.0 } },
  "defaults": { "discount_percent": 0, "discount_amount": 0, "uom": null },
  "row_filters": [ "^(total|subtotal|ppn|note|catatan)\\b" ]
}
```

- All regular expressions are case‑insensitive by default.
- Coordinates (if used) are relative: 0.00 (left) → 1.00 (right).

---

## Step 1 — Map your columns (fields)
Tell the engine which column is which, and how to read it.

```json
"fields": {
  "no": {
    "header_synonyms": ["\\bno\\b"],
    "position_hint": { "x0": 0.05, "x1": 0.12 },
    "parsers": ["parse_int"],
    "required": false,
    "merge": false
  },
  "description": {
    "header_synonyms": ["description of goods", "\\bdescription\\b", "\\bdesc\\b"],
    "position_hint": { "x0": 0.30, "x1": 0.55 },
    "parsers": ["strip_nonprint"],
    "required": false,
    "merge": false
  },
  "qty": {
    "header_synonyms": ["\\bqty\\b", "quantity"],
    "position_hint": { "x0": 0.56, "x1": 0.64 },
    "parsers": ["parse_number"],
    "required": false,
    "merge": false
  },
  "unit_price": {
    "header_synonyms": ["unit\\s*price", "unit\\s*cost"],
    "position_hint": { "x0": 0.65, "x1": 0.78 },
    "parsers": ["parse_money"],
    "required": false,
    "merge": false
  },
  "amount": {
    "header_synonyms": ["\\bamount\\b", "line\\s*total", "\\btotal\\b"],
    "position_hint": { "x0": 0.78, "x1": 0.92 },
    "parsers": ["parse_money"],
    "required": false,
    "merge": false
  }
}
```

How mapping works
- First, the engine tries `header_synonyms` (regex) against the header text in each column.
  - It prefers exact “whole word” matches and longer matches.
- If still unclear, it uses `position_hint`: the column whose center sits inside `x0..x1` and is closest to the middle wins (ties → leftmost).

Parsers (choose from):
- `parse_int`: whole numbers (e.g., “10”).
- `parse_number`: general numbers (e.g., “6.90”).
- `parse_money`: currency amounts (thousands separators and symbols are ignored).
- `parse_percent`: percentage like “10%” → 0.10.
- `split_qty_uom`: reads combined fields like “6.90/KG” and outputs `qty` + `uom`.
- `strip_nonprint`: cleans control characters and extra spaces.
- `normalize_sku`: cleans up a product code (SKU) and, if the cell mixes code + text, also extracts a tidy description.

Tips
- You can define optional fields like `hs_code`, `sku`, or `code` the same way.
- Keep `merge` as `false` unless you know you need to combine multi-cell text (advanced).

---

## Step 2 — Filter out non-item rows
Many tables include “TOTAL”, “SUBTOTAL”, or notes that should not become items.

```json
"row_filters": [
  "^(total|subtotal|ppn|note|catatan)\\b"
]
```

How filtering works
- The engine joins all cell texts in a row and checks your list of regex.
- If any pattern matches, the row is dropped.
- Completely blank rows are dropped automatically.

Add patterns as you discover them (e.g., “^grand total”, “^vat”).

---

## Step 3 — Resolve the Unit of Measure (UOM)
Tell the engine where to pick the UOM when it’s not in the row.

```json
"uom": {
  "precedence": ["row", "header_unit_suffix", "doc", "default"],
  "header_suffix_patterns": ["\\bQTY\\s*\\((?<uom>[A-Z]+)\\)"],
  "doc_patterns": ["\\bSatuan[:\\s]+(?<uom>[A-Z]+)"]
}
```

- Row: if a row already contains a UOM (e.g., via `split_qty_uom`), use it.
- Header unit suffix: pick a unit from the header text like “QTY (PCS)”.
- Doc patterns: look for a unit elsewhere in the document header area.
- Default: if still missing, use `defaults.uom`.

Note: patterns must include a named group `(?<uom>...)` to capture the unit.

---

## Step 4 — Discounts and proration
You can capture discounts per row, or a single discount for the whole document, then fairly split it across items.

```json
"discount": {
  "precedence": ["row", "doc_percent", "doc_amount"],
  "doc_percent_patterns": ["\\bDiskon\\s*(?<pct>\\d+(?:[.,]\\d+)?)%"],
  "doc_amount_patterns": ["\\bDiskon\\s*Rp\\s*(?<amt>[\\d.,]+)"],
  "price_already_discounted": false,
  "applies_before_tax": true,
  "prorate": { "base": "pre_discount_amount" },
  "rounding": "per_line",
  "reconcile": "largest_line"
}
```

Two-pass math (round half up to your `currency_decimals`):
1) Per row: compute `line_base = qty × unit_price`. If a row has either a discount percent or a discount amount, subtract it to get that row’s weight.
2) Document-level discount (if found):
   - Percent → each line gets `percent × weight`.
   - Amount → split by `weight / sum(weights)`.
   - Round each line’s share. If there’s a leftover cent due to rounding, add it to the “largest line” (configurable).

The final `discount_amount` is the sum of row discount + allocated discount. If a row didn’t have a discount percent, the engine back-calculates one from the final discount total and `line_base`.

---

## Step 5 — Currency and rounding
```json
"currency_decimals": 2
```
- All monetary rounding uses “round half up”.
- Rounding applies to every step in discount allocation and amount calculation.

---

## Step 6 — Tolerances and validation
```json
"tolerances": { "amount_from_qty_price": { "abs": 100, "rel": 0.01 } }
```
- If the source row had an `amount`, the engine recomputes `qty × unit_price` and compares.
- If the difference is bigger than `abs + rel × computed`, the computed value is kept and a note is added.

Set `abs` and `rel` according to your currency and expected noise.

---

## Step 7 — Defaults
```json
"defaults": { "discount_percent": 0, "discount_amount": 0, "uom": null }
```
- If a `required` field is missing after parsing, the engine fills it from `defaults` and adds a short note.

---

## Putting it all together — A minimal example

```json
{
  "fields": {
    "no": { "header_synonyms": ["\\bno\\b"], "position_hint": { "x0": 0.05, "x1": 0.12 }, "parsers": ["parse_int"], "required": false, "merge": false },
    "description": { "header_synonyms": ["description"], "position_hint": { "x0": 0.30, "x1": 0.55 }, "parsers": ["strip_nonprint"], "required": false, "merge": false },
    "qty": { "header_synonyms": ["\\bqty\\b"], "position_hint": { "x0": 0.56, "x1": 0.64 }, "parsers": ["parse_number"], "required": false, "merge": false },
    "unit_price": { "header_synonyms": ["unit\\s*price"], "position_hint": { "x0": 0.65, "x1": 0.78 }, "parsers": ["parse_money"], "required": false, "merge": false },
    "amount": { "header_synonyms": ["amount"], "position_hint": { "x0": 0.78, "x1": 0.92 }, "parsers": ["parse_money"], "required": false, "merge": false }
  },
  "uom": {
    "precedence": ["row", "header_unit_suffix", "doc", "default"],
    "header_suffix_patterns": ["\\bQTY\\s*\\((?<uom>[A-Z]+)\\)"],
    "doc_patterns": []
  },
  "discount": {
    "precedence": ["row", "doc_percent", "doc_amount"],
    "doc_percent_patterns": [],
    "doc_amount_patterns": [],
    "price_already_discounted": false,
    "applies_before_tax": true,
    "prorate": { "base": "pre_discount_amount" },
    "rounding": "per_line",
    "reconcile": "largest_line"
  },
  "currency_decimals": 2,
  "tolerances": { "amount_from_qty_price": { "abs": 0, "rel": 0 } },
  "defaults": { "discount_percent": 0, "discount_amount": 0, "uom": "PCS" },
  "row_filters": ["^(total|subtotal|ppn|note|catatan)\\b"]
}
```

Run it with your table input and check the output items. If a column didn’t map correctly, add or tweak `header_synonyms` or adjust `position_hint` ranges so they don’t overlap too much.

---

## Troubleshooting
- Columns not recognized → add more `header_synonyms` or widen/narrow `position_hint`.
- Totals included as items → add a regex to `row_filters` (e.g., `"^grand\\s+total"`).
- Wrong unit → add a `header_suffix_patterns` rule (e.g., `QTY (PCS)`) or set `defaults.uom`.
- Discounts off by a cent → that’s normal rounding; `reconcile: "largest_line"` catches the remainder.
- Amount differs from source → adjust `tolerances` or check for hidden spaces in numbers.

---

## Tips
- Keep configs simple; only add fields you actually need.
- Prefer clear header words over complex regex.
- Reuse one config per vendor/template; swapping configs should produce correct results without code changes.
- Always set `currency_decimals` to match the currency (0 for IDR, 2 for USD/EUR).

---

That’s it. With a small config, you can turn noisy tables into clean, machine‑readable line items reliably.
