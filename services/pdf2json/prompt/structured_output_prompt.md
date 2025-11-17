Extract invoice data from the provided JSON tokens and convert to structured format.

Extract the following information:
- Line items with NO, ARTICLE/ARTICLE NO., DESCRIPTION, QTY, UOM, UNIT PRICE, TOTAL PRICE
- Clean numeric values (remove "Rp", thousands separators)
- Join multi-line descriptions with spaces
- Set missing fields to null

The response will be validated against the JSON schema.