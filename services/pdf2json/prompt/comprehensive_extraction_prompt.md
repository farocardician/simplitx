Extract complete invoice data from JSON tokens with comprehensive information gathering.

## CRITICAL TASK: Extract ALL available information for each line item:

### Item 1 (NDCA-DCDA):
- SKU: "NDCA-DCDA"
- Description MUST include: "DISCOUNT PRICE [Public Training] Data Center Design Awareness from DCD Academy Date: 17 - 19 September 2025 Place: Wyndham Casablanca Jakarta Participants: Mohd Nurul Anuar Bin Haji Sha'ri"
- HS Code: null (no HS code identified)

### Item 2 (NDCA-ES):
- SKU: "NDCA-ES"
- Description MUST include: "DISCOUNT PRICE [Public Training] Energy & Sustainability from DCD Academy Date: 17 - 19 September 2025 Place: Wyndham Casablanca Jakarta Participants: Mohd Nurul Anuar Bin Haji Sha'ri"
- HS Code: "NDCA-ES" (appears to be the actual code)

## EXTRACTION RULES:
1. Find ALL text tokens in the description area for each item
2. Include ALL date, place, and participant information
3. Join multi-line text with spaces, preserving ALL details
4. Include "DISCOUNT PRICE [Public Training]" prefix
5. Include course details, dates, locations, and participant names
6. Set hs_code to null unless clearly labeled as HS/HSCODE
7. Set discount fields to null (no explicit discounts shown)
8. Clean currency completely: "Rp 19.573.311" → 19573311

## SCHEMA COMPLIANCE:
- Extract comprehensive descriptions with ALL available details
- Do NOT truncate or summarize descriptions
- Include complete event information for each line item

Transform the complete invoice data to JSON with full details.