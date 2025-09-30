/**
 * Transforms invoice JSON to XML format (pt_simon_invoice_v1 mapping)
 */

interface InvoiceItem {
  description: string;
  qty: number;
  unit_price: number;
  amount: number;
  sku?: string;
  hs_code: string;
  uom: string;
  type: 'Barang' | 'Jasa';
}

interface InvoiceData {
  invoice?: {
    date?: string;
    number?: string;
  };
  seller?: {
    name?: string;
    tin?: string;
    idtku?: string;
  };
  buyer?: {
    name?: string;
    tin?: string;
    idtku?: string;
    address?: string;
    email?: string;
  };
  items: InvoiceItem[];
  // Additional fields from parser_results.final
  [key: string]: any;
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function padHsCode(hsCode: string): string {
  // Pad HS code to 6 digits by removing non-digits and padding with zeros
  const digits = hsCode.replace(/\D/g, '');
  return digits.padEnd(6, '0').substring(0, 6);
}

function calculateTaxFields(taxBase: number) {
  // OtherTaxBase = TaxBase / 1.09 (removing ~9% margin/markup)
  const otherTaxBase = taxBase / 1.09;
  // VAT = OtherTaxBase * 0.12 (12% VAT rate)
  const vat = otherTaxBase * 0.12;

  return {
    otherTaxBase: parseFloat(otherTaxBase.toFixed(2)),
    vat: parseFloat(vat.toFixed(2))
  };
}

export function buildInvoiceXml(data: InvoiceData): string {
  const sellerTin = data.seller?.tin || '0715420659018000';
  const sellerIdtku = data.seller?.idtku || `${sellerTin}000000`;
  const buyerTin = data.buyer?.tin || '0849873807086000';
  const buyerIdtku = data.buyer?.idtku || `${buyerTin}000000`;
  const invoiceDate = data.invoice?.date || '';
  const refDesc = data.invoice?.number || '';
  const buyerName = data.buyer?.name || '';
  const buyerAddress = data.buyer?.address || '';
  const buyerEmail = data.buyer?.email || '';

  let xml = `<?xml version='1.0' encoding='utf-8'?>
<TaxInvoiceBulk xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <TIN>${escapeXml(sellerTin)}</TIN>
  <ListOfTaxInvoice>
    <TaxInvoice>
      <TaxInvoiceDate>${escapeXml(invoiceDate)}</TaxInvoiceDate>
      <TaxInvoiceOpt>Normal</TaxInvoiceOpt>
      <TrxCode>04</TrxCode>
      <AddInfo></AddInfo>
      <CustomDoc></CustomDoc>
      <CustomDocMonthYear></CustomDocMonthYear>
      <RefDesc>${escapeXml(refDesc)}</RefDesc>
      <FacilityStamp></FacilityStamp>
      <SellerIDTKU>${escapeXml(sellerIdtku)}</SellerIDTKU>
      <BuyerTin>${escapeXml(buyerTin)}</BuyerTin>
      <BuyerDocument>TIN</BuyerDocument>
      <BuyerCountry>IDN</BuyerCountry>
      <BuyerDocumentNumber>-</BuyerDocumentNumber>
      <BuyerName>${escapeXml(buyerName)}</BuyerName>
      <BuyerAdress>${escapeXml(buyerAddress)}</BuyerAdress>
      <BuyerEmail>${escapeXml(buyerEmail)}</BuyerEmail>
      <BuyerIDTKU>${escapeXml(buyerIdtku)}</BuyerIDTKU>
      <ListOfGoodService>
`;

  // Add each item
  data.items.forEach((item) => {
    const { otherTaxBase, vat } = calculateTaxFields(item.amount);
    const hsCode = padHsCode(item.hs_code);
    const opt = item.type === 'Jasa' ? 'J' : '';

    xml += `        <GoodService>
          <Opt>${escapeXml(opt)}</Opt>
          <Code>${escapeXml(hsCode)}</Code>
          <Name>${escapeXml(item.description)}</Name>
          <Unit>${escapeXml(item.uom)}</Unit>
          <Price>${item.unit_price}</Price>
          <Qty>${item.qty}</Qty>
          <TotalDiscount>0</TotalDiscount>
          <TaxBase>${item.amount}</TaxBase>
          <OtherTaxBase>${otherTaxBase}</OtherTaxBase>
          <VATRate>12</VATRate>
          <VAT>${vat}</VAT>
          <STLGRate>0</STLGRate>
          <STLG>0</STLG>
        </GoodService>
`;
  });

  xml += `      </ListOfGoodService>
    </TaxInvoice>
  </ListOfTaxInvoice>
</TaxInvoiceBulk>`;

  return xml;
}
