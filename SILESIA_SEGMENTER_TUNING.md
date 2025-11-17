# Silesia Segmenter Configuration Tuning

## Summary of Changes

Added four new regions to `services/pdf2json/config/s03_invoice_sil_segmenter_v1.json`:

1. **subtotal** - Captures "Items total:" and the associated amount
2. **tax_based** - Captures "Tax Based:" and the associated tax base amount
3. **vat** - Captures the VAT line with rate, amounts, and percentages
4. **grand_total** - Captures "Final invoice amount:" and the total

## Configuration Approach

Following the segmenter tuning playbook guidelines:

- ✅ **Using `line_anchors`**: All regions use `line_anchors` for detection (preferred over `anchors`)
- ✅ **Using `end_anchor`**: All regions use `end_anchor` to bound the region (preferred over `capture_window`)
- ✅ **Conservative margins**: Small negative bottom margin (-0.005) to exclude end_anchor lines
- ✅ **No capture_window**: Not needed since we're using end_anchors
- ✅ **Nested in @total**: All new regions are `"inside": "@total"` to constrain scope
- ✅ **No per-variant hacks**: Configuration uses only pattern matching, no conditionals

### Region Definitions

```json
{
  "id": "subtotal",
  "detect": {
    "by": "line_anchors",
    "start_anchor": {"patterns": ["^Items\\s+total:"]},
    "end_anchor": {"patterns": ["Tax\\s+Based:"]}
  }
}

{
  "id": "tax_based",
  "detect": {
    "by": "line_anchors",
    "start_anchor": {"patterns": ["Tax\\s+Based:"]},
    "end_anchor": {"patterns": ["VAT:"]}
  }
}

{
  "id": "vat",
  "detect": {
    "by": "line_anchors",
    "start_anchor": {"patterns": ["VAT:"]},
    "end_anchor": {"patterns": ["^Final\\s+invoice\\s+amount:"]}
  }
}

{
  "id": "grand_total",
  "detect": {
    "by": "line_anchors",
    "start_anchor": {"patterns": ["^Final\\s+invoice\\s+amount:"]},
    "end_anchor": {"patterns": ["^Terms\\s+of\\s+payment:"]}
  }
}
```

## Testing Instructions

### Quick Test (Single Variant)

Test variant 1 with PYMUPDF tokenizer:

```bash
CLIENT=sil VARIANT=1 SUBFOLDER=training && \
docker exec simplitx-pdf2json-1 python3 stages/s01_tokenizer.py \
  --in /app/$SUBFOLDER/$CLIENT/$VARIANT/$VARIANT.pdf \
  --out /app/$SUBFOLDER/$CLIENT/$VARIANT/s01.json && \
docker exec simplitx-pdf2json-1 python3 stages/s02_normalizer.py \
  --in /app/$SUBFOLDER/$CLIENT/$VARIANT/s01.json \
  --out /app/$SUBFOLDER/$CLIENT/$VARIANT/s02.json && \
docker exec simplitx-pdf2json-1 python3 stages/s03_segmenter.py \
  --in /app/$SUBFOLDER/$CLIENT/$VARIANT/s02.json \
  --out /app/$SUBFOLDER/$CLIENT/$VARIANT/s03.json \
  --config /app/config/s03_invoice_sil_segmenter_v1.json \
  --overlay /app/$SUBFOLDER/$CLIENT/$VARIANT/$VARIANT.pdf \
  --tokenizer PYMUPDF && \
python3 scripts/verifySegmenMultiPage.py \
  --token services/pdf2json/$SUBFOLDER/$CLIENT/$VARIANT/s02.json \
  --segmen services/pdf2json/$SUBFOLDER/$CLIENT/$VARIANT/s03.json \
  --region-id subtotal
```

Repeat for other regions: `tax_based`, `vat`, `grand_total`

### Full Test (All 10 Variants)

Run the provided test script:

```bash
./test_all_sil_variants.sh
```

Or manually test each variant:

```bash
for VARIANT in {1..10}; do
  echo "Testing variant $VARIANT..."

  # Run pipeline
  CLIENT=sil SUBFOLDER=training && \
  docker exec simplitx-pdf2json-1 python3 stages/s01_tokenizer.py \
    --in /app/$SUBFOLDER/$CLIENT/$VARIANT/$VARIANT.pdf \
    --out /app/$SUBFOLDER/$CLIENT/$VARIANT/s01.json && \
  docker exec simplitx-pdf2json-1 python3 stages/s02_normalizer.py \
    --in /app/$SUBFOLDER/$CLIENT/$VARIANT/s01.json \
    --out /app/$SUBFOLDER/$CLIENT/$VARIANT/s02.json && \
  docker exec simplitx-pdf2json-1 python3 stages/s03_segmenter.py \
    --in /app/$SUBFOLDER/$CLIENT/$VARIANT/s02.json \
    --out /app/$SUBFOLDER/$CLIENT/$VARIANT/s03.json \
    --config /app/config/s03_invoice_sil_segmenter_v1.json \
    --overlay /app/$SUBFOLDER/$CLIENT/$VARIANT/$VARIANT.pdf \
    --tokenizer PYMUPDF

  # Verify regions
  for REGION in subtotal tax_based vat grand_total; do
    echo "  Checking $REGION..."
    python3 scripts/verifySegmenMultiPage.py \
      --token services/pdf2json/$SUBFOLDER/$CLIENT/$VARIANT/s02.json \
      --segmen services/pdf2json/$SUBFOLDER/$CLIENT/$VARIANT/s03.json \
      --region-id $REGION
  done
done
```

### Alternative: Python Validation Script

If `verifySegmenMultiPage.py` is not available, use the provided validation script:

```bash
python3 validate_sil_regions.py
```

This will show the extracted text for each region across all 10 variants.

## Expected Outputs

### Variant 1
- **subtotal**: `Items total:\n129.508.650,00`
- **tax_based**: `\nTax Based:\n118.716.262,50`
- **vat**: `VAT:\n12 118.716.262,50\n11,000 %\n129.508.650,00 14.245.951,50`
- **grand_total**: `Final invoice amount: IDR 143.754.601,50`

### Variant 2
- **subtotal**: `Items total:\n14.782.880,00`
- **tax_based**: `\nTax Based:\n13.550.973,33`
- **vat**: `VAT:\n12 13.550.973,33\n14.782.880,00 1.626.116,80`
- **grand_total**: `Final invoice amount: IDR 16.408.996,80`

### Variants 3-10
Expected to match Variant 1 output (based on the requirements provided).

## Acceptance Checklist

Before marking this complete, verify:

- [ ] No stray tokens before/after each block
- [ ] Works across all variants 1-10 without per-variant hacks
- [ ] PYMUPDF and PLUMBER both work (PYMUPDF is preferred/more accurate)
- [ ] All four regions (subtotal, tax_based, vat, grand_total) are correctly extracted
- [ ] No negative capture_window values
- [ ] Behavior is controlled by config keys (not hardcoded)
- [ ] Config JSON is valid and properly formatted

## Troubleshooting

### Region not found
- Check that the anchor pattern matches the actual text in the PDF
- Verify the `@total` parent region is being detected correctly
- Check the s03.json output to see if the region has a bbox

### Stray tokens captured
- Tighten the `end_anchor` pattern
- Adjust the negative bottom margin (currently -0.005)
- Check if tokens are actually within the bounding box using the overlay PDF

### Pattern doesn't match
- Review the actual line text in s02.json (check both PYMUPDF and PLUMBER)
- Adjust regex patterns to handle spacing variations
- Consider using `normalize_space: true` flag (already enabled)

## Files Modified

- `services/pdf2json/config/s03_invoice_sil_segmenter_v1.json` - Added 4 new regions

## Files Created

- `test_all_sil_variants.sh` - Automated test script for all variants
- `validate_sil_regions.py` - Python validation script (alternative to verifySegmenMultiPage.py)
- `SILESIA_SEGMENTER_TUNING.md` - This documentation file
