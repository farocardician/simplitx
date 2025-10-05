# Invoice Segmentation Fine-Tuning Guide

This guide explains how to configure the invoice segmenter (`s03_segmenter.py`) to accurately extract regions from PDF invoices.

## Table of Contents
1. [Overview](#overview)
2. [The Segmentation Strategy](#the-segmentation-strategy)
3. [Understanding Capture Window Modes](#understanding-capture-window-modes)
4. [Choosing the Right Anchor](#choosing-the-right-anchor)
5. [Fine-Tuning with Tolerances and Margins](#fine-tuning-with-tolerances-and-margins)
6. [Verification Workflow](#verification-workflow)
7. [Common Patterns and Solutions](#common-patterns-and-solutions)

---

## Overview

The invoice segmenter works in three stages:
1. **s02**: Tokenizes PDF into individual text tokens with bounding boxes
2. **s03**: Groups tokens into labeled regions using anchor-based detection
3. Verification: Ensures regions capture exactly the intended tokens

**Goal**: Each region must capture its target tokens with 100% coverage and no extra tokens.

---

## The Segmentation Strategy

### 1. Hierarchical Region Structure

Invoices follow a consistent two-level hierarchy:

```
├── header (top-level region)
│   ├── invoice_number (child)
│   ├── invoice_date (child)
│   └── buyer_name (child)
└── total (top-level region)
    ├── subtotal (child)
    ├── vat (child)
    └── grand_total (child)
```

**Key Rule**: Child regions MUST be geometrically contained within their parent's bounding box.

### 2. The Workflow

```bash
# Step 1: Examine tokens
docker exec simplitx-pdf2json-1 python3 -c "
import json
with open('/app/results/{name}/s02-{name}.json', 'r') as f:
    data = json.load(f)

tokens = data['plumber']['tokens']
for tok in tokens[:50]:  # Examine first 50 tokens
    print(f\"{tok['id']:3d} {tok['norm']:20s} y={tok['bbox']['y0']:.4f}\")"

# Step 2: Create config file
# (see sections below)

# Step 3: Run segmenter
docker exec simplitx-pdf2json-1 python3 stages/s03_segmenter.py \
  --in /app/results/{name}/s02-{name}.json \
  --out /app/results/{name}/s03-{name}.json \
  --config /app/config/s03_invoice_{name}_segmenter_v1.json \
  --tokenizer plumber

# Step 4: Verify coverage
docker exec simplitx-pdf2json-1 python3 -c "
import json
# ... verification script (see Verification section)
"
```

---

## Understanding Capture Window Modes

The capture window mode determines how tokens are selected around the anchor. Choose based on the invoice layout.

### Mode 1: `around` - Same Line Label+Value

**Use when**: Label and value are on the same line with small gap

```json
{
  "capture_window": {
    "mode": "around",
    "dx": 0.15,    // horizontal distance
    "dy": 0.002    // vertical tolerance (very tight)
  }
}
```

**Example**:
- Token layout: `Invoice No : T03/12/2021` (all on same line)
- Anchor: `"No"`
- Captures: `Invoice No : T03/12/2021`

**Why it works**: Captures tokens within a tight bounding box around the anchor, excluding distant tokens.

### Mode 2: `right_then_rows` - Multi-token Same Row

**Use when**: Multiple tokens on the same row, extending to the right

```json
{
  "capture_window": {
    "mode": "right_then_rows",
    "start_edge": "left",
    "rows": 0,           // same row only
    "row_tol": 0.002,    // vertical alignment tolerance
    "dx_max": 0.35,      // max horizontal distance
    "gap_x": 0           // min gap between tokens
  }
}
```

**Example**:
- Token layout: `TO : PT BIROTIKA SEMESTA / DHL EXPRESS` (one line)
- Anchor: `"TO:"` (structural label, NOT the company prefix "PT")
- Captures: `PT BIROTIKA SEMESTA / DHL EXPRESS` (using gap_x to skip the colon)

**⚠️ IMPORTANT**: Never use `PT`, `CV`, `Ltd.`, or any company-specific prefix as anchors. Always use structural keywords like `TO`, `TO:`, `SOLD TO:`, etc.

**Why it works**: Follows tokens horizontally on the same row, stopping at dx_max or when gap exceeds gap_x.

### Mode 3: `below_rows` - Value on Next Line

**Use when**: Value is on the line below the label

```json
{
  "capture_window": {
    "mode": "below_rows",
    "rows": 1,           // number of rows below
    "row_tol": 0.005,    // row alignment tolerance
    "width": "anchor",   // or "page"
    "pad_left": 0.0,
    "pad_right": 0.1
  }
}
```

**Example**:
- Line 1: `Invoice Date :`
- Line 2: `28/12/21`
- Anchor: `"Date"`
- Captures: `28/12/21` (skips the first row, captures second)

**Why it works**: Skips to the next row(s) and captures tokens within the specified width.

### Mode 4: `below_only` - Everything Below Anchor

**Use when**: Capturing a large region containing multiple sub-regions

```json
{
  "capture_window": {
    "mode": "below_only",
    "dy_max": 0.15,      // vertical distance limit
    "width": "page"      // full page width
  }
}
```

**Example**:
- Anchor: `"INVOICE"` at top
- Captures: All tokens in the header area below the anchor

**Why it works**: Creates a rectangular region extending downward from the anchor.

---

## Choosing the Right Anchor

> **⚠️ CRITICAL RULE**: NEVER use company-specific prefixes like `PT`, `PT.`, `CV`, `Inc.`, `Ltd.` as anchors. These are variable content, not structural elements. Always anchor on structural keywords like `TO`, `TO:`, `SOLD TO:`, `Bill To:`, etc.

### Anchor Selection Principles

1. **Use structural labels, NOT content-specific patterns**
   - ✅ Good: `"TO"`, `"TO:"`, `"SOLD TO:"`, `"Bill To:"`, `"INVOICE"`, `"Date"`, `"Number"`
   - ❌ Bad: `"PT"`, `"PT."`, `"CV"`, `"Inc."`, `"Ltd."`, company names, specific invoice numbers

2. **Why avoid content-specific anchors?**
   - Company prefixes vary across organizations (`PT`, `PT.`, `CV`, `Inc.`, `Ltd.`, `LLC`, etc.)
   - Same pattern may appear in multiple contexts (e.g., "PT" in company name AND address)
   - Dramatically reduces config reusability across different invoices
   - Creates brittle configs that break with vendor changes

3. **Use regex when needed**
   ```json
   {
     "patterns": ["^TO:?$"],  // Matches "TO" or "TO:"
     "flags": {
       "ignore_case": false,
       "normalize_space": true
     }
   }
   ```

### Example: Finding buyer_name

**Bad approach** (content-specific):
```json
{
  "start_anchor": {
    "patterns": ["^PT$"]  // ❌ Not all companies start with PT
  }
}
```

**Good approach** (structural):
```json
{
  "start_anchor": {
    "patterns": ["^TO:$"]  // ✅ Structural label, works across invoices
  }
}
```

---

## Fine-Tuning with Tolerances and Margins

### Tolerances: Control Capture Precision

**Row Tolerance** (`row_tol`, `dy_tol`):
- Controls vertical alignment precision
- Typical values: `0.002` - `0.005`
- Lower = stricter (avoids adjacent lines)
- Higher = more permissive

**Example problem**: Capturing extra lines
```
After anchoring on "TO:", you want to capture:
Desired:  PT BIROTIKA SEMESTA         (y=0.1567)  ← Company name content
Unwanted: JL. MT. HARYONO              (y=0.1842)  ← Too close!
```

**Solution**: Use tight `row_tol: 0.002` to exclude the unwanted line.

**Note**: The "PT" above is the company name CONTENT being captured, not the anchor. The anchor is "TO:" or similar structural keyword.

### Margins: Fine-Tune Boundaries

Margins adjust the final region bounding box:
- **Positive margin**: Expands region (includes more)
- **Negative margin**: Shrinks region (excludes content)

```json
{
  "margin": {
    "top": -0.017,     // Shrink top (exclude tokens above)
    "bottom": -0.019,  // Shrink bottom (exclude tokens below)
    "left": 0.0,
    "right": 0.0
  }
}
```

**Use case**: Skip contact person lines to get company name
```
Line 1: Bpk. Mustafa Gobel            ← Exclude with margin.top
Line 2: Human Capital Director        ← Exclude with margin.top
Line 3: PT. Gotrans Logistics International  ← Capture this!
```

Solution: Use `margin: {top: -0.017, bottom: -0.019}` to shrink the region and capture only line 3.

---

## Verification Workflow

### 1. Check Token Coverage

```python
import json

with open('/app/results/{name}/s03-{name}.json', 'r') as f:
    s03 = json.load(f)

with open('/app/results/{name}/s02-{name}.json', 'r') as f:
    s02 = json.load(f)

tokens = s02['plumber']['tokens']

for seg in s03['segments']:
    if seg['id'] in ['invoice_number', 'buyer_name', 'subtotal', 'vat', 'grand_total']:
        bbox = seg['bbox']
        captured = []
        for tok in tokens:
            tb = tok['bbox']
            # Check overlap
            if (tb['x1'] > bbox[0] and tb['x0'] < bbox[2] and
                tb['y1'] > bbox[1] and tb['y0'] < bbox[3]):
                captured.append(tok['norm'])
        print(f"{seg['id']}: {' '.join(captured)}")
```

### 2. Expected vs Actual

Compare captured tokens against requirements:

| Region | Required | Actual | Status |
|--------|----------|--------|--------|
| invoice_number | `Invoice No : T03/12/2021` | `Invoice No : T03/12/2021` | ✅ |
| buyer_name | `PT. Gotrans Logistics` | `PT. Gotrans Logistics International` | ❌ Extra tokens |
| subtotal | `Total 184.988.502` | `Total` | ❌ Missing value |

### 3. Iterative Refinement

**If region captures extra tokens:**
- Tighten `dy_tol` / `row_tol` (reduce from 0.005 → 0.002)
- Reduce `dx_max` (horizontal limit)
- Add negative margins to shrink region

**If region misses tokens:**
- Increase `dx_max` or `dy_max`
- Relax `row_tol` slightly
- Adjust `pad_left` / `pad_right`
- Check if using correct capture mode

---

## Common Patterns and Solutions

### Pattern 1: Header Region (Parent)

**Goal**: Capture entire header area including all child regions

```json
{
  "id": "header",
  "on_pages": "first",
  "detect": {
    "by": "anchors",
    "start_anchor": {
      "patterns": ["^INVOICE$"],
      "select": "first"
    },
    "capture_window": {
      "mode": "below_only",
      "dy_max": 0.18,        // Adjust based on header size
      "width": "page"
    },
    "margin": {
      "top": 0.0,
      "bottom": -0.02,       // Shrink to exclude table headers
      "left": 0.0,
      "right": 0.0
    }
  },
  "fallbacks": [
    {
      "by": "y_cutoff",      // Fallback if anchor not found
      "edge": "top",
      "y": 0.38
    }
  ]
}
```

### Pattern 2: Invoice Number (Child)

**Layout**: `Invoice No : T03/12/2021` (same line)

```json
{
  "id": "invoice_number",
  "inside": "@header",       // MUST be inside parent
  "detect": {
    "by": "anchors",
    "start_anchor": {
      "patterns": ["^No$"],
      "select": "first"
    },
    "capture_window": {
      "mode": "around",
      "dx": 0.15,            // Capture label + value
      "dy": 0.002            // Tight vertical tolerance
    }
  }
}
```

### Pattern 3: Invoice Date (Child - Date on Next Line)

**Layout**:
```
Invoice Date :
28/12/21
```

```json
{
  "id": "invoice_date",
  "inside": "@header",
  "detect": {
    "by": "anchors",
    "start_anchor": {
      "patterns": ["^Date$"],
      "select": "first"
    },
    "capture_window": {
      "mode": "around",      // Use around with same-line label
      "dx": 0.15,
      "dy": 0.002
    }
  }
}
```

### Pattern 4: Buyer Name (Child - Structural Anchor)

**Layout**: `TO : PT PERTAMINA TRAINING AND CONSULTING`

```json
{
  "id": "buyer_name",
  "inside": "@header",
  "detect": {
    "by": "anchors",
    "start_anchor": {
      "patterns": ["^TO$"],   // ✅ Structural, not "PT"
      "select": "first"
    },
    "capture_window": {
      "mode": "right_then_rows",
      "start_edge": "right",
      "rows": 0,
      "row_tol": 0.002,
      "dx_max": 0.45,
      "gap_x": 0.03          // Skip colon
    }
  }
}
```

### Pattern 5: Total Region (Parent)

**Goal**: Container for subtotal, vat, grand_total

```json
{
  "id": "total",
  "on_pages": "all",
  "detect": {
    "by": "anchors",
    "start_anchor": {
      "patterns": ["^Total$"],  // First "Total" on page
      "select": "first"
    },
    "capture_window": {
      "mode": "around",
      "dx": 0.7,               // Wide to include all children
      "dy": 0.025              // Vertical span
    }
  },
  "fallbacks": [
    {
      "by": "y_cutoff",
      "edge": "bottom",
      "y": 0.65
    }
  ]
}
```

### Pattern 6: Subtotal (Child - Label+Value Same Line)

**Layout**: `Total 184.988.502`

```json
{
  "id": "subtotal",
  "inside": "@total",
  "detect": {
    "by": "anchors",
    "start_anchor": {
      "patterns": ["^Total$"],
      "select": "first"        // First "Total" inside @total
    },
    "capture_window": {
      "mode": "around",
      "dx": 0.65,              // Wide enough for value
      "dy": 0.002
    }
  }
}
```

### Pattern 7: VAT (Child - Multi-row)

**Layout**:
```
VAT 10%
Of our fees 18.498.850
```

```json
{
  "id": "vat",
  "inside": "@total",
  "detect": {
    "by": "anchors",
    "start_anchor": {
      "patterns": ["^VAT$"],
      "select": "first"
    },
    "capture_window": {
      "mode": "right_then_rows",
      "start_edge": "left",
      "rows": 1,               // Include next row
      "row_tol": 0.005,
      "dx_max": 0.7
    }
  }
}
```

### Pattern 8: Grand Total (Child - Multi-row)

**Layout**:
```
Amount to be
paid 203.487.352
```

```json
{
  "id": "grand_total",
  "inside": "@total",
  "detect": {
    "by": "anchors",
    "start_anchor": {
      "patterns": ["^Amount$"],
      "select": "first"
    },
    "capture_window": {
      "mode": "right_then_rows",
      "start_edge": "left",
      "rows": 1,
      "row_tol": 0.005,
      "dx_max": 0.7
    }
  }
}
```

---

## Best Practices Checklist

### Before Creating Config
- [ ] Examine s02 tokens to understand layout
- [ ] Identify structural anchor patterns (not content-specific)
- [ ] Note y-coordinates to determine dy_max values
- [ ] Check for multi-line values (use rows parameter)

### During Configuration
- [ ] Use `"inside": "@parent"` for all child regions
- [ ] Set `min_height: 0.011` in defaults to allow small regions
- [ ] Start with conservative capture windows, then expand
- [ ] Use tight tolerances (0.002-0.005) to avoid extra tokens

### After Each Run
- [ ] Verify 100% coverage of required tokens
- [ ] Check for unwanted tokens in regions
- [ ] Ensure child regions fit within parent bbox
- [ ] Test with margin adjustments for fine-tuning

### Common Mistakes to Avoid
- ❌ **NEVER use company-specific prefixes as anchors** (`PT`, `PT.`, `CV`, `Inc.`, `Ltd.`, etc.)
  - These vary between companies and reduce config reusability
  - Always use structural keywords: `TO`, `TO:`, `SOLD TO:`, `Bill To:`, etc.
- ❌ Overly wide dy_max capturing adjacent lines
- ❌ Forgetting `"inside": "@parent"` for child regions
- ❌ Not checking actual vs expected token coverage
- ❌ Using same anchor pattern twice without `select: "first"/"last"`

---

## Debugging Tips

### Issue: Region not detected
```
total_segments": 7  (expected 8)
```
**Solution**:
1. Check if anchor exists in s02 tokens
2. Verify anchor pattern (case-sensitive)
3. Check if child region is outside parent bbox
4. Try using fallback detection

### Issue: Extra tokens captured
```
buyer_name: TO : PT PERTAMINA TRAINING Invoice Number 12345
                                        ^^^^^^^^^^^^^^^^^^^^ unwanted
```
**Solution**:
1. Reduce `dx_max` to limit horizontal capture
2. Tighten `row_tol` to avoid adjacent lines
3. Use `gap_x` to stop at large gaps
4. Apply negative margins to shrink region

### Issue: Missing value tokens
```
subtotal: Total  (missing "184.988.502")
```
**Solution**:
1. Increase `dx_max` to capture farther tokens
2. Use `"mode": "around"` with wider `dx`
3. Check token x-coordinates in s02
4. Try `right_then_rows` mode instead

---

## Advanced Techniques

### Technique 1: Skip Rows with Margins

To skip unwanted rows and capture specific content:

```json
{
  "capture_window": {
    "mode": "below_only",
    "dy_max": 0.05
  },
  "margin": {
    "top": -0.017,    // Skip first N pixels
    "bottom": -0.019  // Skip last N pixels
  }
}
```

### Technique 2: Select Specific Anchor Occurrence

When anchor appears multiple times:

```json
{
  "start_anchor": {
    "patterns": ["^Total$"],
    "select": "first"   // or "last", or "all"
  }
}
```

### Technique 3: Width Constraints

Limit horizontal capture area:

```json
{
  "capture_window": {
    "mode": "below_rows",
    "rows": 1,
    "width": "anchor",     // or "page"
    "pad_left": 0.05,
    "pad_right": 0.35
  }
}
```

---

## Summary

1. **Start with token analysis** - Understand the layout before configuring
2. **Use structural anchors** - Avoid content-specific patterns like "PT"
3. **Choose the right capture mode** - Match mode to layout pattern
4. **Iterate with verification** - Check coverage, adjust tolerances
5. **Fine-tune with margins** - Exclude unwanted content precisely
6. **Maintain hierarchy** - Children must fit inside parents

By following this guide, you can create accurate segmentation configs that work reliably across different invoice layouts.
