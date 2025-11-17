You must return ONLY a JSON object starting with { and ending with }. No other text allowed.

Transform the invoice data into this exact JSON format:

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

Now transform this input data: