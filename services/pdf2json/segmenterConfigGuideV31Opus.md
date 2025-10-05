# Agnostic Region Segmenter — Configuration Guide (v3.3)

This guide explains how to configure the **agnostic** segmenter: everything is a region, you pick where it runs, how to find it, and what to do if the first try fails. The language is plain, the knobs are small, and the behavior is predictable.

---

## Quick start
- Define a **region** with an `id` and where it runs: `on_pages: "all" | "first" | "last" | "odd" | "even"`
- Choose a **detection mode** in `detect.by` (`anchors`, `by_table`, `y_cutoff`, or `fixed_box`)
- Add **fallbacks** inside `detect.fallbacks` (first success wins)
- (Optional) Use `inside` to make a region **child** of another and auto-clip it
- (Optional) Use `only_if_contains` as a quick **guard** so the region only runs on relevant pages
- (Optional) Control duplicates with `keep: "all" | "first" | "last"`

---

## Top-level layout

```json
{
  "name": "config_name",
  "coords": {
    "normalized": true,
    "y_origin": "top",
    "precision": 6
  },
  "tolerances": {
    "y_line_tol": 0.006
  },
  "defaults": {
    "min_height": 0.02,
    "margin": { "top": 0.005, "right": 0.005, "bottom": 0.005, "left": 0.005 }
  },
  "regions": [ /* see below */ ]
}
```

**Coordinates** are normalized to 0..1. With `y_origin: "top"`, y increases downward.

---

## Core keys (per region)
- **`id`** (required): unique name
- **`label`** (optional): human-friendly name
- **`on_pages`**: where to run — strict grammar only: `"all" | "first" | "last" | "odd" | "even"`
- **`keep`** (optional): `"all"` (default), `"first"`, or `"last"` — which matches to keep across the pages you searched
- **`inside`** (optional): `"@parent_id"` — run as a child of another region, clipped inside the parent
- **`only_if_contains`** (optional): array of words/regex; if none match on a page, skip the region on that page
- **`detect`**: primary detection mode and params
- **`detect.fallbacks`**: ordered list of alternatives; first success wins

> Notes: Unknown `on_pages` values warn and default to `"all"`. If a child’s parent is missing on a page, the child is skipped on that page.

---

## Keep policy (when it matters)
- **`keep: "all"`** — keep every page hit (default)
- **`keep: "first"`** — keep the first page that matches
- **`keep: "last"`** — keep the last page that matches

`keep` only matters if `on_pages` covers more than one page (e.g., `"all"`, `"odd"`, `"even"`). If you use `"first"` or `"last"` for `on_pages`, `keep` is irrelevant.

---

## Detection modes

### Input formats (all normalize to the canonical `"by"` shape)
```json
// String
"detect": "y_cutoff"

// Single-key object
"detect": { "y_cutoff": { "edge": "top", "y": 0.12 } }

// Canonical
"detect": { "by": "y_cutoff", "edge": "top", "y": 0.12 }
```

### 1) `anchors` — find a region from text anchors
Use patterns to find a start anchor (and optional end anchor), then wrap it with margins or a capture window.

```json
"detect": {
  "by": "anchors",
  "start_anchor": {
    "patterns": ["INVOICE", "FAKTUR"],
    "flags": { "ignore_case": true, "normalize_space": true },
    "select": "first"   // aliases supported: leftmost|rightmost|topmost|bottommost|next_below
  },
  "end_anchor": {
    "patterns": ["DATE"],
    "select": "next_below"
  },
  "margin": { "top": 0.004, "right": 0.01, "bottom": 0.004, "left": 0.01 },
  "fallbacks": [
    { "by": "y_cutoff", "edge": "top", "y": 0.12 },
    { "by": "fixed_box", "bbox": [0.00, 0.00, 1.00, 0.18] }
  ]
}
```

#### Capture window (optional)
After `start_anchor` matches, you can capture a nearby area with `capture_window`. If tokens are found inside, the union of those tokens is returned. If no tokens are found, the window rectangle itself is returned (respecting `min_height`).

**Common params** (non-negative unless stated):
- `dx_max`, `dy_max`, `dy_tol` — horizontal width, vertical reach, and tiny vertical tolerance
- `rows`, `row_tol` — row count and grouping tolerance (for row modes; rows ≥ 1)
- `width: "anchor" | "page"` — horizontal extent for vertical row/blocks
- `pad_left`, `pad_right` — extra horizontal padding when `width: "anchor"`
- `start_edge: "right" | "left"` — where to measure from in directional modes (defaults follow the direction)
- `gap_x` — tiny horizontal buffer from the chosen edge, pushed in the expansion direction

**Coordinate-oriented modes**
- `right_then_down` — expand right from the chosen edge, include same line + a bit below (`dx_max`, `dy_max`, `dy_tol`, `start_edge?`, `gap_x?`)
- `left_then_down` — expand left from the chosen edge, include same line + a bit below (`dx_max`, `dy_max`, `dy_tol`, `start_edge?`, `gap_x?`)
- `right_then_up` — expand right from the chosen edge, include a bit **above** (`dx_max`, `dy_max`, `dy_tol`, `start_edge?`, `gap_x?`)
- `left_then_up` — expand left from the chosen edge, include a bit **above** (`dx_max`, `dy_max`, `dy_tol`, `start_edge?`, `gap_x?`)
- `right_only` — same-row to the right (`dx_max`, `dy_tol`, `start_edge?`, `gap_x?`)
- `left_only` — same-row to the left (`dx_max`, `dy_tol`, `start_edge?`, `gap_x?`)
- `below_only` — vertical block below (`dy_max`, `width: "anchor"|"page"`, `pad_left`, `pad_right`, optional `dx_max`)
- `around` — symmetric padding around anchor (`dx`, `dy`)

**Row/line–oriented modes**
- `right_then_rows` — same row + next N rows to the right (`rows`, `dx_max`, `row_tol`, `start_edge?`, `gap_x?`)
- `left_then_rows` — same row + next N rows to the left (`rows`, `dx_max`, `row_tol`, `start_edge?`, `gap_x?`)
- `below_rows` — next N rows below (page- or anchor-width) (`rows`, `row_tol`, `width`, `pad_left`, `pad_right`, optional `dx_max`)
- `above_rows` — previous N rows above (page- or anchor-width) (`rows`, `row_tol`, `width`, `pad_left`, `pad_right`)

**Tips**
- If label text bleeds into the capture: add a small `gap_x` and/or set `start_edge` appropriately.
- For label → value on one line, try `right_only` or `left_only` first; for short multi-line values, try `right_then_rows`.

### 2) `by_table` — place a region above/below a table
```json
"detect": {
  "by": "by_table",
  "position": "above",     // or "below"
  "which": "first",        // or "last" (defaults depend on position)
  "margin": 0.02
}
```
Behavior:
- If no tables are available on the page, returns `null` so fallbacks can run.
- Defaults: `position:"above" → which:"first"`, `position:"below" → which:"last"`.

### 3) `y_cutoff` — cut by a fixed Y
```json
"detect": { "by": "y_cutoff", "edge": "top", "y": 0.15 }
```

### 4) `fixed_box` — explicit coordinates
```json
"detect": { "by": "fixed_box", "bbox": [0.00, 0.00, 1.00, 0.15] }
```

---

## Fallback chains
Put fallbacks **inside** `detect.fallbacks`. Order from most specific to most generic. The first success wins.
```json
"detect": {
  "by": "anchors",
  "start_anchor": { "patterns": ["INVOICE"] },
  "fallbacks": [
    { "by": "by_table", "position": "above" },
    { "by": "y_cutoff", "edge": "top", "y": 0.12 },
    { "by": "fixed_box", "bbox": [0, 0, 1, 0.1] }
  ]
}
```

---

## Parent / child (`inside`)
```json
{
  "id": "buyer_box",
  "inside": "@header",
  "on_pages": "first",
  "detect": {
    "by": "anchors",
    "start_anchor": { "patterns": ["Buyer|Customer"], "select": "first", "flags": { "ignore_case": true } },
    "capture_window": { "mode": "right_then_down", "dx_max": 0.30, "dy_max": 0.15, "dy_tol": 0.008 }
  }
}
```
Behavior:
- Parents resolve before children (topological order)
- If parent missing on a page, child is skipped there
- Child bbox is clipped to the parent bbox

---

## Guards (`only_if_contains`)
```json
"only_if_contains": ["INVOICE", "FAKTUR", "BILL"]
```
If **any** term matches the page (case-insensitive), the region runs on that page. Otherwise it’s skipped.

---

## Defaults (global)
```json
"defaults": {
  "min_height": 0.02,
  "margin": { "top": 0.005, "right": 0.005, "bottom": 0.005, "left": 0.005 }
}
```
Applied unless overridden in the region or mode.

---

## Best practices
1) Order fallbacks from **specific** → **generic**  
2) Use `only_if_contains` to avoid false positives across templates  
3) Prefer `right_only` / `right_then_rows` for label → value captures  
4) Keep `row_tol` small for dense layouts; increase if lines are loose  
5) Use `keep: "first"` for unique ids; `keep: "last"` for end-of-doc summaries

---

## Troubleshooting
- **No result**: check `on_pages`, guard terms, and parent existence
- **Wrong area**: tighten `dx_max/dy_max` or `rows/row_tol`; add `gap_x`; try a different mode
- **Too many results**: use `keep` or narrow pages
- **by_table empty**: make sure tables are detected upstream or rely on fallbacks
- **Child not found**: confirm parent id and that it exists on that page

---

## Mini examples

**Header strip (all pages) with table fallback**
```json
{
  "id": "header",
  "on_pages": "all",
  "keep": "all",
  "detect": { "by": "by_table", "position": "above" },
  "fallbacks": [ { "y_cutoff": { "edge": "top", "y": 0.14 } } ]
}
```

**Invoice number (first page), same-line value to the right**
```json
{
  "id": "invoice_number",
  "on_pages": "first",
  "keep": "first",
  "inside": "@header",
  "detect": {
    "by": "anchors",
    "start_anchor": { "patterns": ["Invoice\s*No\.?:?"], "select": "leftmost", "flags": { "ignore_case": true } },
    "capture_window": { "mode": "right_only", "start_edge": "right", "gap_x": 0.01, "dx_max": 0.35, "dy_tol": 0.008 }
  }
}
```

**Grand total (last page), two rows below the label**
```json
{
  "id": "grand_total",
  "on_pages": "last",
  "keep": "last",
  "detect": {
    "by": "anchors",
    "start_anchor": { "patterns": ["GRAND\s+TOTAL|TOTAL"], "select": "bottommost", "flags": { "ignore_case": true } },
    "capture_window": { "mode": "right_then_rows", "rows": 2, "dx_max": 0.30, "row_tol": 0.008 }
  }
}
```

**Notes block (vertical band under label, anchor width)**
```json
{
  "id": "notes",
  "on_pages": "all",
  "detect": {
    "by": "anchors",
    "start_anchor": { "patterns": ["Notes|Catatan"], "select": "first", "flags": { "ignore_case": true } },
    "capture_window": { "mode": "below_only", "dy_max": 0.22, "width": "anchor", "pad_left": 0.01, "pad_right": 0.01 }
  },
  "fallbacks": [ { "by": "y_cutoff", "edge": "bottom", "y": 0.80 } ]
}
```

---

## Compatibility
- If your engine expects `pages` / `parent` instead of `on_pages` / `inside`, a tiny pre-processor can map the keys.
- Selection names like `"first"` may normalize to `"first_in_reading_order"` internally — both are fine if your normalizer handles them.
- Distances should be non-negative. If a window collapses or clips to zero area, it returns nothing.
- In some builds, `keep` only applies to top-level regions. If you need child-level `keep`, enable it in the engine or push the policy up to the parent.

---

**That’s it.** Keep configs small and clear; let the fallbacks and guards do the heavy lifting. Happy segmenting!
