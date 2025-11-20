import { format } from 'date-fns';

interface ParsedTaxInvoice {
  refDesc: string;
  taxInvoiceNode: string;
  tinNode: string;
  declaration: string;
  rootOpenTag: string;
  listOpenTag: string;
}

function chunkify(value: string) {
  const parts = value.match(/\d+|\D+/g);
  if (!parts) return [{ value, isNumber: false }];
  return parts.map(part => ({
    value: part,
    isNumber: /^\d+$/.test(part)
  }));
}

export function compareRefDesc(aRaw: string, bRaw: string): number {
  const a = aRaw.trim();
  const b = bRaw.trim();

  const aChunks = chunkify(a);
  const bChunks = chunkify(b);
  const maxLen = Math.max(aChunks.length, bChunks.length);

  for (let i = 0; i < maxLen; i++) {
    const aChunk = aChunks[i];
    const bChunk = bChunks[i];

    if (!aChunk && !bChunk) return 0;
    if (!aChunk) return -1;
    if (!bChunk) return 1;

    if (aChunk.isNumber && bChunk.isNumber) {
      const aNum = parseInt(aChunk.value, 10);
      const bNum = parseInt(bChunk.value, 10);
      if (aNum !== bNum) return aNum - bNum;
      // If numeric values are equal, shorter chunk wins (e.g., 2 < 002)
      if (aChunk.value.length !== bChunk.value.length) {
        return aChunk.value.length - bChunk.value.length;
      }
      continue;
    }

    if (aChunk.isNumber !== bChunk.isNumber) {
      // Numbers come before text to get natural ordering.
      return aChunk.isNumber ? -1 : 1;
    }

    const textCompare = aChunk.value.localeCompare(bChunk.value, undefined, {
      sensitivity: 'base',
      numeric: false
    });
    if (textCompare !== 0) return textCompare;
  }

  return aChunks.length - bChunks.length;
}

function parseTaxInvoiceXml(xmlContent: string): ParsedTaxInvoice {
  const declarationMatch = xmlContent.match(/<\?xml[^>]*\?>/i);
  const declaration = declarationMatch?.[0]?.trim() || `<?xml version="1.0" encoding="utf-8"?>`;

  const rootOpenMatch = xmlContent.match(/<TaxInvoiceBulk[^>]*>/i);
  const rootOpenTag = rootOpenMatch?.[0]?.trim() || '<TaxInvoiceBulk>';

  const listOpenMatch = xmlContent.match(/<ListOfTaxInvoice[^>]*>/i);
  const listOpenTag = listOpenMatch?.[0]?.trim() || '<ListOfTaxInvoice>';

  const tinMatch = xmlContent.match(/<TIN[^>]*>[\s\S]*?<\/TIN>/i);
  const tinNode = tinMatch?.[0]?.trim() || '<TIN></TIN>';

  // Extract only the TaxInvoice node, not the entire TaxInvoiceBulk wrapper
  const listOfTaxInvoiceMatch = xmlContent.match(/<ListOfTaxInvoice[^>]*>([\s\S]*?)<\/ListOfTaxInvoice>/i);
  if (!listOfTaxInvoiceMatch) {
    throw new Error('No <ListOfTaxInvoice> node found in XML content');
  }

  const listContent = listOfTaxInvoiceMatch[1];
  const taxInvoiceMatch = listContent.match(/<TaxInvoice[^>]*>[\s\S]*?<\/TaxInvoice>/i);
  if (!taxInvoiceMatch) {
    throw new Error('No <TaxInvoice> node found in XML content');
  }

  const taxInvoiceNode = taxInvoiceMatch[0].trim();
  const refDescMatch = taxInvoiceNode.match(/<RefDesc[^>]*>([\s\S]*?)<\/RefDesc>/i);
  const refDesc = (refDescMatch?.[1] || '').trim();

  return {
    refDesc,
    taxInvoiceNode,
    tinNode,
    declaration,
    rootOpenTag,
    listOpenTag
  };
}

export function mergeInvoiceXmlContents(xmlContents: string[]): { mergedXml: string; refDescs: string[] } {
  if (xmlContents.length < 2) {
    throw new Error('At least two XML files are required to merge');
  }

  const parsed = xmlContents.map(content => parseTaxInvoiceXml(content));
  const sorted = [...parsed].sort((a, b) => compareRefDesc(a.refDesc, b.refDesc));

  const base = sorted[0];
  const taxInvoiceNodes = sorted.map(node => `    ${node.taxInvoiceNode}`);
  const mergedXml = [
    base.declaration,
    base.rootOpenTag,
    `  ${base.tinNode}`,
    `  ${base.listOpenTag}`,
    taxInvoiceNodes.join('\n'),
    '  </ListOfTaxInvoice>',
    '</TaxInvoiceBulk>'
  ].join('\n');

  return {
    mergedXml,
    refDescs: sorted.map(node => node.refDesc)
  };
}

export function buildMergedFilename(mapping: string, count: number): string {
  const safeMapping = mapping.replace(/\.json$/i, '');
  const datePart = format(new Date(), 'ddMMyy');
  return `${safeMapping}_combined_${datePart}_${count}.xml`;
}
