You are a Senior PDF Segmentation Engineer. Tune invoice segmentation using s03_segmenter.py and the config.

Goal
Produce regions that exactly cover the labeled token blocks below, with strict geometric nesting:
• invoice_number, invoice_date, buyer_name ⊂ header
• subtotal, vat, grand_total ⊂ total

Doc Vars
SEGMENTER_PATH = "services/pdf2json/stages/s03_segmenter.py"
TOKENS_PATH = "services/pdf2json/results/sis/s02-sis.json"
OUTPUT_PATH = "services/pdf2json/results/sis/s03-sis.json"
CONFIG_PATH = "services/pdf2json/config/s03_invoice_sis_segmenter_v1.json"

Step 1 — Understand the segmenter
Read s03_segmenter.py line by line. Know how anchors, capture_window, margin, min_height, row_tol, rows, start_edge, gap_x, width, pad_left/right, and the “inside” parent scoping influence detection and stitching.

Step 2 — Configure regions
A) header (top-level) — must fully includeTheseTokens:
LOREMIPSUM

Child: invoice_number — must be strictly inside header and fully includeTheseTokens:
LOREMIPSUM

Child: invoice_date — must be strictly inside header and fully includeTheseTokens:
LOREMIPSUM

Child: buyer_name — must be strictly inside header and fully includeTheseTokens:
LOREMIPSUM
• Do not use "PT" or "CV" as anchor patterns (they are unreliable). Choose a more stable keyword or structural anchor.

B) total (top-level) — must fully includeTheseTokens:
LOREMIPSUM

Child: subtotal — must be strictly inside total and fully includeTheseTokens:
LOREMIPSUM

Child: vat — must be strictly inside total and fully includeTheseTokens:
LOREMIPSUM

Child: grand_total — must be strictly inside total and fully includeTheseTokens:
LOREMIPSUM

Token-content rules
• Treat tokens as {text, page, bbox} in reading order. Work on normalized text.
• Labels are case-insensitive; allow flexible spacing.
• Geometric containment is strict: every child bbox lies fully inside its parent bbox.
• No extra tokens allowed: each region must contain only the tokens specified in includeTheseTokens, nothing more.

General rules
• Always Use stable anchors (labels/regex/structure). Never hard-code specific numbers or names for detection.
• Keep capture_window/margin tight enough to avoid noise, wide enough to allow little drift.
• For children, set "inside": "<parent_id>" and do not set "on_pages" (inherit page scope).

Step 3 — Verify each segment using script below:

./scripts/verifySegmen.py --token TOKENS_PATH --segmen OUTPUT_PATH --region-id {region, for example invoice_number}  --tokenizer plumber --check-coverage {"Fill with Each Segment includeTheseTokens"}