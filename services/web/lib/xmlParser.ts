/**
 * Parses invoice XML (pt_simon_invoice_v1 format) back to JSON
 */

interface ParsedInvoiceItem {
  description: string;
  qty: number;
  unit_price: number;
  amount: number;
  sku?: string;
  hs_code: string;
  uom: string;
  type: 'Barang' | 'Jasa';
}

interface ParsedInvoiceData {
  invoice_no: string;
  seller_name: string;
  buyer_name: string;
  invoice_date: string;
  items: ParsedInvoiceItem[];
  trx_code: string | null;
}

/**
 * Simple XML text extraction helper
 */
function extractTextBetweenTags(xml: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}>([^<]*)<\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

function mapOptToType(opt: string): 'Barang' | 'Jasa' {
  const normalized = opt.trim().toUpperCase();
  if (normalized === 'B' || normalized === 'J') {
    return 'Jasa';
  }
  return 'Barang';
}

/**
 * Extract all GoodService items from XML
 */
function extractGoodServiceItems(xml: string): ParsedInvoiceItem[] {
  const items: ParsedInvoiceItem[] = [];

  // Find all GoodService blocks
  const goodServiceRegex = /<GoodService>([\s\S]*?)<\/GoodService>/gi;
  const matches = Array.from(xml.matchAll(goodServiceRegex));

  for (const match of matches) {
    const itemXml = match[1];

    const opt = extractTextBetweenTags(itemXml, 'Opt');
    const code = extractTextBetweenTags(itemXml, 'Code');
    const name = extractTextBetweenTags(itemXml, 'Name');
    const unit = extractTextBetweenTags(itemXml, 'Unit');
    const price = extractTextBetweenTags(itemXml, 'Price');
    const qty = extractTextBetweenTags(itemXml, 'Qty');
    const taxBase = extractTextBetweenTags(itemXml, 'TaxBase');

    items.push({
      description: name || '',
      qty: parseFloat(qty) || 0,
      unit_price: parseFloat(price) || 0,
      amount: parseFloat(taxBase) || 0,
      sku: '', // SKU not stored in XML
      hs_code: code || '',
      uom: unit || '',
      type: mapOptToType(opt)
    });
  }

  return items;
}

/**
 * Parse XML and extract invoice data
 */
export function parseInvoiceXml(xmlContent: string): ParsedInvoiceData {
  const invoiceDate = extractTextBetweenTags(xmlContent, 'TaxInvoiceDate');
  const refDesc = extractTextBetweenTags(xmlContent, 'RefDesc');
  const buyerName = extractTextBetweenTags(xmlContent, 'BuyerName');
  const trxCode = extractTextBetweenTags(xmlContent, 'TrxCode');

  const items = extractGoodServiceItems(xmlContent);

  return {
    invoice_no: refDesc,
    seller_name: 'Seller', // Not stored in XML, will be merged from parser_results
    buyer_name: buyerName || 'Buyer',
    invoice_date: invoiceDate,
    items,
    trx_code: trxCode || null
  };
}
