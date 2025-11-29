/**
 * Invoice completeness validation utilities
 *
 * Validates that all required fields for Coretax XML schema are present and valid
 * for both invoice-level and item-level data.
 */

import { prisma } from '@/lib/prisma';

type InvoiceData = {
  tax_invoice_date: Date | null;
  trx_code: string | null;
  ref_desc: string | null;
  seller_idtku: string | null;
  buyer_tin: string | null;
  buyer_document: string | null;
  buyer_country: string | null;
  buyer_name: string | null;
  buyer_address: string | null;
  buyer_idtku: string | null;
};

type ItemData = {
  opt: string | null;
  code: string | null;
  name: string | null;
  unit: string | null;
  price: number | null;
  qty: number | null;
  total_discount: number | null;
  tax_base: number | null;
  other_tax_base: number | null;
  vat_rate: number | null;
  vat: number | null;
};

type CompletenessResult = {
  isComplete: boolean;
  missingFields: string[];
};

/**
 * Validates if a date string follows YYYY-MM-DD format and is a valid date
 */
function isValidDate(date: Date | null): boolean {
  if (!date) return false;

  // Check if it's a valid Date object
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return false;
  }

  // Additional validation for month length and leap years
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  // Check month range
  if (month < 1 || month > 12) return false;

  // Days in each month
  const daysInMonth = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  // Check day range
  if (day < 1 || day > daysInMonth[month - 1]) return false;

  return true;
}

/**
 * Validates invoice-level fields
 */
async function validateInvoiceFields(invoice: InvoiceData): Promise<string[]> {
  const missing: string[] = [];

  // TaxInvoiceDate - must be valid date
  if (!isValidDate(invoice.tax_invoice_date)) {
    missing.push('tax_invoice_date');
  }

  // TrxCode - must match existing transaction code
  if (!invoice.trx_code || invoice.trx_code.trim() === '') {
    missing.push('trx_code');
  } else {
    const codeExists = await prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM transaction_codes WHERE code = ${invoice.trx_code} LIMIT 1
    `;
    if (codeExists[0]?.count === 0) {
      missing.push('trx_code');
    }
  }

  // RefDesc
  if (!invoice.ref_desc || invoice.ref_desc.trim() === '') {
    missing.push('ref_desc');
  }

  // SellerIDTKU
  if (!invoice.seller_idtku || invoice.seller_idtku.trim() === '') {
    missing.push('seller_idtku');
  }

  // BuyerTin
  if (!invoice.buyer_tin || invoice.buyer_tin.trim() === '') {
    missing.push('buyer_tin');
  }

  // BuyerDocument
  if (!invoice.buyer_document || invoice.buyer_document.trim() === '') {
    missing.push('buyer_document');
  }

  // BuyerCountry
  if (!invoice.buyer_country || invoice.buyer_country.trim() === '') {
    missing.push('buyer_country');
  }

  // BuyerName
  if (!invoice.buyer_name || invoice.buyer_name.trim() === '') {
    missing.push('buyer_name');
  }

  // BuyerAddress
  if (!invoice.buyer_address || invoice.buyer_address.trim() === '') {
    missing.push('buyer_address');
  }

  // BuyerIDTKU
  if (!invoice.buyer_idtku || invoice.buyer_idtku.trim() === '') {
    missing.push('buyer_idtku');
  }

  return missing;
}

/**
 * Validates item-level fields
 */
async function validateItemFields(items: ItemData[]): Promise<string[]> {
  const missing: string[] = [];

  if (items.length === 0) {
    return ['items']; // Must have at least one item
  }

  let hasInvalidOpt = false;
  let hasInvalidHsCode = false;
  let hasInvalidUom = false;
  let hasMissingName = false;
  let hasInvalidNumeric = false;

  // Collect all unique HS codes and UOMs for batch validation
  const hsCodes = new Set<string>();
  const uoms = new Set<string>();

  for (const item of items) {
    // Opt - must be A or B
    if (!item.opt || (item.opt !== 'A' && item.opt !== 'B')) {
      hasInvalidOpt = true;
    }

    // Code (HS code) - collect for validation
    if (item.code && item.code.trim() !== '') {
      hsCodes.add(item.code);
    } else {
      hasInvalidHsCode = true;
    }

    // Name
    if (!item.name || item.name.trim() === '') {
      hasMissingName = true;
    }

    // Unit - collect for validation
    if (item.unit && item.unit.trim() !== '') {
      uoms.add(item.unit);
    } else {
      hasInvalidUom = true;
    }

    // Numeric fields - must be present (can be 0)
    if (
      item.price === null || item.price === undefined ||
      item.qty === null || item.qty === undefined ||
      item.total_discount === null || item.total_discount === undefined ||
      item.tax_base === null || item.tax_base === undefined ||
      item.other_tax_base === null || item.other_tax_base === undefined ||
      item.vat_rate === null || item.vat_rate === undefined ||
      item.vat === null || item.vat === undefined
    ) {
      hasInvalidNumeric = true;
    }
  }

  // Batch validate HS codes
  if (hsCodes.size > 0) {
    const validHsCodes = await prisma.$queryRaw<{ code: string }[]>`
      SELECT code FROM hs_codes WHERE code = ANY(${Array.from(hsCodes)})
    `;
    const validCodesSet = new Set(validHsCodes.map(r => r.code));

    for (const code of hsCodes) {
      if (!validCodesSet.has(code)) {
        hasInvalidHsCode = true;
        break;
      }
    }
  }

  // Batch validate UOMs
  if (uoms.size > 0) {
    const validUoms = await prisma.$queryRaw<{ code: string }[]>`
      SELECT code FROM unit_of_measures WHERE code = ANY(${Array.from(uoms)})
    `;
    const validUomsSet = new Set(validUoms.map(r => r.code));

    for (const uom of uoms) {
      if (!validUomsSet.has(uom)) {
        hasInvalidUom = true;
        break;
      }
    }
  }

  // Add to missing fields
  if (hasInvalidOpt) missing.push('opt');
  if (hasInvalidHsCode) missing.push('hs_codes');
  if (hasMissingName) missing.push('name');
  if (hasInvalidUom) missing.push('unit');
  if (hasInvalidNumeric) missing.push('numeric_fields');

  return missing;
}

/**
 * Validates completeness of an invoice and its items
 * @param invoiceId The UUID of the invoice to validate
 * @returns Object with isComplete flag and array of missing field names
 */
export async function validateInvoiceCompleteness(invoiceId: string): Promise<CompletenessResult> {
  // Fetch invoice data
  const invoiceRows = await prisma.$queryRaw<InvoiceData[]>`
    SELECT
      tax_invoice_date,
      trx_code,
      ref_desc,
      seller_idtku,
      buyer_tin,
      buyer_document,
      buyer_country,
      buyer_name,
      buyer_address,
      buyer_idtku
    FROM tax_invoices_enriched
    WHERE id::text = ${invoiceId}
    LIMIT 1
  `;

  if (invoiceRows.length === 0) {
    throw new Error(`Invoice ${invoiceId} not found`);
  }

  const invoice = invoiceRows[0];

  // Fetch items data
  const items = await prisma.$queryRaw<ItemData[]>`
    SELECT
      opt,
      code,
      name,
      unit,
      price,
      qty,
      total_discount,
      tax_base,
      other_tax_base,
      vat_rate,
      vat
    FROM tax_invoice_items
    WHERE tax_invoice_id::text = ${invoiceId}
    ORDER BY line_number ASC
  `;

  // Validate both invoice and items
  const invoiceMissing = await validateInvoiceFields(invoice);
  const itemsMissing = await validateItemFields(items);

  const allMissing = [...invoiceMissing, ...itemsMissing];

  return {
    isComplete: allMissing.length === 0,
    missingFields: allMissing
  };
}

/**
 * Updates the is_complete and missing_fields columns for an invoice
 * @param invoiceId The UUID of the invoice to update
 */
export async function updateInvoiceCompleteness(invoiceId: string): Promise<void> {
  const result = await validateInvoiceCompleteness(invoiceId);

  await prisma.$executeRaw`
    UPDATE tax_invoices
    SET is_complete = ${result.isComplete},
        missing_fields = ${JSON.stringify(result.missingFields)}::jsonb,
        updated_at = NOW()
    WHERE id::text = ${invoiceId}
  `;
}
