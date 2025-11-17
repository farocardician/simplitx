# Totals Segmentation Tuning Playbook

## Table of Contents
- [Why This Playbook Exists](#why-this-playbook-exists)
- [Signals That Trigger a Tuning Pass](#signals-that-trigger-a-tuning-pass)
- [Config-First Workflow](#config-first-workflow)
- [Anchor Strategy](#anchor-strategy)
- [Shaping The Region](#shaping-the-region)
- [Fallbacks And Resilience](#fallbacks-and-resilience)
- [Validation Loop](#validation-loop)
- [Reusable Snippets](#reusable-snippets)
- [Readiness Checklist](#readiness-checklist)

## Why This Playbook Exists
Totals-style regions (`total`, `subtotal`, `grand_total`, tax blocks, etc.) pick up noisy headings, footer text, or silently drop lines whenever vendors change layout. This playbook documents a repeatable, config-driven method to tighten those regions without sprinkling per-vendor hacks.

## Signals That Trigger a Tuning Pass
- Expected numeric ladder is missing, duplicated, or pulls footer text (e.g., city/date lines).
- PYMUPDF and PLUMBER disagree on the same region.
- A new variant adds or removes intermediate lines (e.g., “ASF 10% …”).
- Layout moves from table headers to key-value rows, breaking the existing start anchor.

## Config-First Workflow
1. **Inspect current config**: open the vendor segmenter JSON and locate the totals region(s). Note the detection mode, anchors, capture window, and fallbacks.
2. **Review raw text**: use `scripts/verifySegmen.py` on an affected variant to see both token streams.
3. **Confirm line inventory**: if behaviour differs between `plumber` and `pymupdf`, the start anchor must work for both, so anchor against the cleanest common tokens (usually uppercase labels).
4. **Prototype edits**: tweak only the target region. Keep changes data-driven—no per-variant conditionals.
5. **Re-run segmentation** for all relevant variants (often the full 1–9 range) with the updated config.
6. **Validate the extract** with `verifySegmen.py`. Only ship once totals read identically across engines and variants.

## Anchor Strategy
- **Prefer `line_anchors` for headings**. They operate on stitched line objects, which avoids partial matches from columnar tables.
- **Start anchors**: aim for the first stable keyword (`^TOTAL\b`, `^PPn`, etc.). Use `normalize_space` to absorb double spaces, and expand with optional prefixes when variants prepend tokens (`^(?:QTY\s+)?NO`).
- **End anchors**: when headings consistently appear in a certain order, use downstream labels (e.g., first `^TOTAL\b` below the block) as the bounding floor. Otherwise layer in `capture_window` to express “one row below the last PPn”.
- **“Next item” pattern**: If the block should end before a paragraph (e.g., “Komersial…”), anchor against the first line whose text shape signals the next section (keywords, all-caps, or numeric lines).

## Shaping The Region
- **Margins**: use small positive top margins when you need to scoop column headers even if the anchor lands on the first data row. Negative bottom margins are an easy way to prune the anchor line when it’s just a guard (e.g., `TOTAL`).
- **Capture windows**:
  - `below_only` keeps things vertical—set `dy_max` slightly above the expected stack height and clamp `pad_left/right` to add breathing room without capturing footers.
  - `below_rows` / `right_then_rows` are perfect when the block is row-based and row count is stable. `rows=1` with `row_tol≈0.004` works well for “line immediately after PPn”.
  - Always keep tolerances non-negative and tighter than 0.01 unless you knowingly span wide gaps.
- **Inside / Parent regions**: nesting a `grand_total` inside `@total` prevents the parent from drifting, while allowing the child to focus on the row it needs.

## Fallbacks And Resilience
- Provide at least one alternate detection path. Example: primary detection via `line_anchors`, fallback via generic `anchors` or a `capture_window` from a higher-level heading.
- Add a `y_cutoff` fallback that captures the lower page half only if both anchor-based passes fail.
- Keep fallback behaviour equivalent in scope—don’t let it wander farther than the primary detection.

## Validation Loop
1. Re-run the tokenizer/segmenter pipeline for each variant that matters:
   ```bash
   CLIENT=<vendor> VARIANT=<N> && \
   docker exec simplitx-pdf2json-1 python3 stages/s01_tokenizer.py \
     --in /app/results/$CLIENT/$VARIANT/$VARIANT.pdf \
     --out /app/results/$CLIENT/$VARIANT/s01.json && \
   docker exec simplitx-pdf2json-1 python3 stages/s02_normalizer.py \
     --in /app/results/$CLIENT/$VARIANT/s01.json \
     --out /app/results/$CLIENT/$VARIANT/s02.json && \
   docker exec simplitx-pdf2json-1 python3 stages/s03_segmenter.py \
     --in /app/results/$CLIENT/$VARIANT/s02.json \
     --out /app/results/$CLIENT/$VARIANT/s03.json \
     --config /app/config/s03_invoice_${CLIENT}_segmenter_v1.json \
     --overlay /app/results/$CLIENT/$VARIANT/$VARIANT.pdf \
     --tokenizer plumber
   ```
2. Compare the region output with `scripts/verifySegmen.py`:
   ```bash
   python3 scripts/verifySegmen.py \
     --token services/pdf2json/results/$CLIENT/$VARIANT/s02.json \
     --segmen services/pdf2json/results/$CLIENT/$VARIANT/s03.json \
     --region-id total
   ```
3. Check both `=== PLUMBER ====` and `=== PYMUPDF ====` blocks for perfect alignment.
4. Repeat for `subtotal`, `grand_total`, or any sibling region you touched.

## Reusable Snippets
- **Line-anchor total with guard window**
  ```json
  "detect": {
    "by": "line_anchors",
    "start_anchor": {
      "patterns": ["^TOTAL\\b"],
      "flags": {"normalize_space": true},
      "select": "first"
    },
    "end_anchor": {
      "patterns": ["^GRAND\\s+TOTAL\\b", "^Pembayaran\\s+Termin", "^SUB\\s+TOTAL\\b"],
      "flags": {"normalize_space": true},
      "select": "last"
    },
    "capture_window": {
      "mode": "below_only",
      "dy_max": 0.06,
      "width": "anchor",
      "pad_left": 0.03,
      "pad_right": 0.05
    }
  }
  ```
- **Grand total under PPn**
  ```json
  "detect": {
    "by": "line_anchors",
    "start_anchor": {
      "patterns": ["\\bPPn\\b"],
      "flags": {"normalize_space": true},
      "select": "last"
    },
    "capture_window": {
      "mode": "below_rows",
      "rows": 1,
      "row_tol": 0.004,
      "width": "page"
    }
  }
  ```
- **Table block bounded by first TOTAL**
  ```json
  "detect": {
    "by": "line_anchors",
    "start_anchor": {
      "patterns": ["^(?:QTY\\s+)?NO\\s+DESCRIPTION\\b"],
      "flags": {"normalize_space": true},
      "select": "first"
    },
    "end_anchor": {
      "patterns": ["^TOTAL\\b"],
      "select": "first"
    },
    "margin": {"top": 0.02, "bottom": -0.015, "left": 1.0}
  }
  ```

## Readiness Checklist
- [ ] Anchors match across PLUMBER and PYMUPDF token streams.
- [ ] The region excludes downstream footers or duplicate totals.
- [ ] Capture windows use non-negative tolerances and conservative spans.
- [ ] Fallbacks cover the failure modes without expanding scope.
- [ ] Regression suite (all known variants) produces identical total text for both engines.
- [ ] Changes are fully expressed in config; no code paths rely on vendor-specific conditionals.

Keep this playbook close whenever a new vendor or variant arrives. The same patterns—clean anchors, disciplined capture windows, thorough validation—scale across the catalogue.
