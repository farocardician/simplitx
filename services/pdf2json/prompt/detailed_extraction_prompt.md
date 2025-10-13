Extract complete invoice data from JSON tokens with precise field mapping according to the exact schema requirements.

## DETAILED FIELD EXTRACTION RULES:

### SKU and HS Code Identification:
- Look for codes under ARTICLE/ARTICLE NO. column
- If multiple codes exist: use leftmost as `sku`, additional codes as `hs_code`
- Example: "NDCA-ES" and "70E8301TY" → sku: "70E8301TY", hs_code: "NDCA-ES"
- Single code: assign to `sku`, set `hs_code` to null

### Description Construction:
- Include ALL text in the description area
- Start with any prefix text like "DISCOUNT PRICE [Public Training]"
- Include date, place, participant information
- Join multi-line content with spaces
- Preserve brackets, punctuation, and formatting

### Complete Description Example:
"DISCOUNT PRICE [Public Training] Data Center Design Awareness from DCD Academy Date: 17 - 19 September 2025 Place: Wyndham Casablanca Jakarta Participants: Mohd Nurul Anuar Bin Haji Sha'ri"

### Numeric Processing:
- Remove "Rp" and all separators: "Rp 19.573.311" → 19573311
- Handle comma decimals: "Rp 17.500.000,00" → 17500000

### Schema Compliance:
- hs_code: string or null (actual HS codes when identified)
- code: null (unless separate article codes exist)
- discount_amount: null (unless explicit discount values shown)
- discount_percent: null (unless explicit discount percentages shown)

Extract ALL available information including dates, locations, and participant details from the token data.