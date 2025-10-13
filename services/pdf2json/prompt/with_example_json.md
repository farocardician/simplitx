TASK: Convert invoice data to JSON. RESPONSE MUST BE JSON ONLY.

EXAMPLE OUTPUT FORMAT:
{"items":[{"no":1,"hs_code":null,"sku":"NDCA-DCDA","code":null,"description":"DISCOUNT PRICE [Public Training] Data Center Design Awareness from DCD Academy","qty":1,"uom":"PAX","unit_price":19573311,"discount_amount":null,"discount_percent":null,"amount":19573311}],"stage":null,"version":null,"notes":null}

RULES:
- Return ONLY JSON object like the example above
- No explanations, no analysis, no commentary
- Start with { and end with }
- Convert input invoice data to match this structure

Now transform this data: