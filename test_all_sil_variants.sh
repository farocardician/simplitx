#!/bin/bash
#
# Test script to run segmentation and validation for all Silesia variants (1-10)
# This script will run the full pipeline for each variant and show the extracted text
#

set -e

CLIENT="sil"
SUBFOLDER="training"
REGIONS=("subtotal" "tax_based" "vat" "grand_total")
TOKENIZERS=("PYMUPDF" "plumber")

echo "==============================================="
echo "Testing Silesia Segmenter Configuration"
echo "==============================================="
echo ""

# Function to run pipeline for a single variant
run_variant() {
    local VARIANT=$1
    local TOKENIZER=$2

    echo "→ Processing Variant $VARIANT with $TOKENIZER..."

    # Run pipeline
    docker exec simplitx-pdf2json-1 python3 stages/s01_tokenizer.py \
      --in /app/$SUBFOLDER/$CLIENT/$VARIANT/$VARIANT.pdf \
      --out /app/$SUBFOLDER/$CLIENT/$VARIANT/s01.json 2>&1 | grep -v "^$" || true

    docker exec simplitx-pdf2json-1 python3 stages/s02_normalizer.py \
      --in /app/$SUBFOLDER/$CLIENT/$VARIANT/s01.json \
      --out /app/$SUBFOLDER/$CLIENT/$VARIANT/s02.json 2>&1 | grep -v "^$" || true

    docker exec simplitx-pdf2json-1 python3 stages/s03_segmenter.py \
      --in /app/$SUBFOLDER/$CLIENT/$VARIANT/s02.json \
      --out /app/$SUBFOLDER/$CLIENT/$VARIANT/s03.json \
      --config /app/config/s03_invoice_sil_segmenter_v1.json \
      --overlay /app/$SUBFOLDER/$CLIENT/$VARIANT/$VARIANT.pdf \
      --tokenizer $TOKENIZER 2>&1 | grep -v "^$" || true

    echo "  ✓ Pipeline complete"
}

# Function to verify a region for a variant
verify_region() {
    local VARIANT=$1
    local REGION=$2

    echo ""
    echo "--- Variant $VARIANT: Region '$REGION' ---"
    python3 scripts/verifySegmenMultiPage.py \
      --token services/pdf2json/$SUBFOLDER/$CLIENT/$VARIANT/s02.json \
      --segmen services/pdf2json/$SUBFOLDER/$CLIENT/$VARIANT/s03.json \
      --region-id $REGION 2>&1 || echo "  ⚠ Verification failed or script not found"
}

# Test each variant
for VARIANT in {1..10}; do
    echo ""
    echo "==============================================="
    echo "VARIANT $VARIANT"
    echo "==============================================="

    # Run pipeline with PYMUPDF (user mentioned this is more accurate)
    run_variant $VARIANT "PYMUPDF"

    # Verify all regions
    for REGION in "${REGIONS[@]}"; do
        verify_region $VARIANT $REGION
    done

    echo ""
done

echo ""
echo "==============================================="
echo "Testing Complete!"
echo "==============================================="
echo ""
echo "Please review the output above to ensure:"
echo "  1. No stray tokens before/after each block"
echo "  2. All expected values are captured"
echo "  3. Works consistently across all variants 1-10"
echo ""
