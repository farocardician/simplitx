Extract invoice data from the provided JSON tokens and convert to the exact JSON schema specified.

## SCHEMA REQUIREMENTS (STRICT):
- no: integer (line item number)
- hs_code: null (unless clearly marked as HS/HSCODE)
- sku: string (leftmost alphanumeric code under ARTICLE/ARTICLE NO.)
- code: null (unless additional codes present beyond SKU)
- description: string (join multi-line tokens with spaces, preserve punctuation)
- qty: integer or number
- uom: string (PAX, Unit, etc.)
- unit_price: integer (strip "Rp", remove separators, e.g., "Rp 3.500.000" → 3500000)
- discount_amount: null (unless explicit discount shown)
- discount_percent: null (unless explicit discount percentage shown)
- amount: integer (total amount, strip currency formatting)

## FIELD MAPPING RULES:
1. Use the first alphanumeric code as `sku`, set `code` to null
2. Set `hs_code` to null unless specifically labeled as HS code
3. Set discount fields to null unless clearly shown in the line item
4. Join description text across multiple lines into single string
5. Clean numeric values completely (remove currency symbols and separators)

## EXAMPLES:
- "Rp 3.500.000" → 3500000
- "Rp 17.500.000,00" → 17500000
- Missing discount → discount_amount: null, discount_percent: null

Extract and format the data according to these exact requirements.