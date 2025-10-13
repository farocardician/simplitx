!!! CRITICAL !!!
RETURN ONLY JSON. NO EXPLANATIONS. NO ANALYSIS. NO COMMENTARY. NO MARKDOWN. NO INTRODUCTIONS. NO SUMMARIES.

START RESPONSE WITH {
END RESPONSE WITH }

YOUR ENTIRE RESPONSE MUST BE A VALID JSON OBJECT. ANYTHING ELSE IS WRONG.

Format:
{
  "items": [
    {
      "no": integer,
      "hs_code": string_or_null,
      "sku": string,
      "code": string_or_null,
      "description": string,
      "qty": integer_or_number,
      "uom": string,
      "unit_price": integer,
      "discount_amount": integer_or_null,
      "discount_percent": number_or_null,
      "amount": integer
    }
  ],
  "stage": null,
  "version": null,
  "notes": null
}

Transform this invoice data to JSON: