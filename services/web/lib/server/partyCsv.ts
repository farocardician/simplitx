import { PartyType } from '@prisma/client';

export interface PartyWithSeller {
  id: string;
  displayName: string;
  tinDisplay: string;
  countryCode: string | null;
  transactionCode: string | null;
  email: string | null;
  addressFull: string | null;
  buyerDocument: string | null;
  buyerDocumentNumber: string | null;
  buyerIdtku: string | null;
  partyType: PartyType;
  sellerId: string | null;
  seller?: {
    id: string;
    displayName: string;
    tinDisplay: string;
  } | null;
}

export const PARTY_CSV_COLUMNS = [
  'display_name',
  'party_type',
  'tin_display',
  'country_code',
  'transaction_code',
  'email',
  'address_full',
  'buyer_document',
  'buyer_document_number',
  'buyer_idtku',
  'seller_display_name',
  'seller_internal_party_id__do_not_edit',
  'internal_party_id__do_not_edit'
] as const;

export type PartyCsvColumn = (typeof PARTY_CSV_COLUMNS)[number];

const REQUIRED_IMPORT_COLUMNS: PartyCsvColumn[] = [
  'display_name',
  'party_type',
  'tin_display',
  'internal_party_id__do_not_edit',
  'seller_internal_party_id__do_not_edit'
];

export interface ParsedPartyCsvRow {
  rowNumber: number;
  data: Record<PartyCsvColumn, string>;
}

export interface PartyCsvParseResult {
  rows: ParsedPartyCsvRow[];
}

function escapeCsvValue(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const needsQuotes = /[",\n\r]/.test(value);
  if (!needsQuotes) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function splitCsv(content: string): string[][] {
  const rows: string[][] = [];
  let currentValue = '';
  let currentRow: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentValue += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentValue += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      currentRow.push(currentValue);
      currentValue = '';
    } else if (char === '\n') {
      currentRow.push(currentValue);
      rows.push(currentRow);
      currentRow = [];
      currentValue = '';
    } else if (char === '\r') {
      continue;
    } else {
      currentValue += char;
    }
  }

  currentRow.push(currentValue);
  rows.push(currentRow);

  return rows.filter(row => row.some(cell => cell.trim().length > 0));
}

export function exportPartiesToCsv(parties: PartyWithSeller[]): string {
  const header = PARTY_CSV_COLUMNS.join(',');
  const lines = parties.map((party) => {
    const cells: Record<PartyCsvColumn, string | null> = {
      display_name: party.displayName,
      party_type: party.partyType,
      tin_display: party.tinDisplay,
      country_code: party.countryCode,
      transaction_code: party.transactionCode,
      email: party.email,
      address_full: party.addressFull,
      buyer_document: party.buyerDocument,
      buyer_document_number: party.buyerDocumentNumber,
      buyer_idtku: party.buyerIdtku,
      seller_display_name: party.seller ? `${party.seller.displayName} (${party.seller.tinDisplay})` : '',
      seller_internal_party_id__do_not_edit: party.sellerId,
      internal_party_id__do_not_edit: party.id
    };

    return PARTY_CSV_COLUMNS
      .map((column) => escapeCsvValue(cells[column]))
      .join(',');
  });

  return [header, ...lines].join('\n');
}

export function parsePartyCsv(content: string): PartyCsvParseResult {
  const rows = splitCsv(content);
  if (rows.length === 0) {
    throw new Error('CSV is empty');
  }

  const headerRow = rows[0].map((value) => value.trim().toLowerCase());
  const columnIndexes: Partial<Record<PartyCsvColumn, number>> = {};

  headerRow.forEach((header, index) => {
    const column = PARTY_CSV_COLUMNS.find(col => col.toLowerCase() === header);
    if (column) {
      columnIndexes[column] = index;
    }
  });

  const missing = REQUIRED_IMPORT_COLUMNS.filter(col => columnIndexes[col] === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing required columns: ${missing.join(', ')}`);
  }

  const dataRows: ParsedPartyCsvRow[] = [];

  rows.slice(1).forEach((row, idx) => {
    if (!row.some(cell => cell.trim().length > 0)) {
      return;
    }

    const data = {} as Record<PartyCsvColumn, string>;

    PARTY_CSV_COLUMNS.forEach((column) => {
      const colIndex = columnIndexes[column];
      const value = colIndex !== undefined ? (row[colIndex] ?? '') : '';
      data[column] = value;
    });

    dataRows.push({
      rowNumber: idx + 2,
      data
    });
  });

  return { rows: dataRows };
}
