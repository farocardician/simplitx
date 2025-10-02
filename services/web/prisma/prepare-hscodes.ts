#!/usr/bin/env tsx

/**
 * HS Code CSV Preprocessor
 *
 * Filters and cleans the raw HS code CSV for import:
 * - Keeps only goods (excludes services)
 * - Validates HS2/HS4/HS6 code lengths
 * - Deduplicates (first occurrence wins)
 * - Computes parent references
 * - Excludes placeholder codes like "000000"
 */

import * as fs from 'fs';
import * as path from 'path';

interface RawHSCode {
  hs_code: string;
  level: string;
  hs2: string;
  hs4: string;
  hs6: string;
  hs8: string;
  hs10: string;
  english_description: string;
  indonesian_description: string;
}

interface CleanHSCode {
  code: string;
  level: 'HS2' | 'HS4' | 'HS6';
  parent_code: string | null;
  description_en: string;
  description_id: string;
  jurisdiction: string;
  version_year: number;
}

const INPUT_CSV = process.env.INPUT_CSV || path.join(__dirname, '../../../context/hscode_clean.csv');
const OUTPUT_CSV = process.env.OUTPUT_CSV || path.join(__dirname, 'hscodes_filtered.csv');

function parseCSV(content: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        currentField += '"';
        i++;
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // Field separator
      currentRow.push(currentField);
      currentField = '';
    } else if (char === '\n' && !inQuotes) {
      // Row separator
      currentRow.push(currentField);
      if (currentRow.some(f => f.trim() !== '')) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else {
      currentField += char;
    }
  }

  // Add last field and row
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.some(f => f.trim() !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}

function isServiceDescription(desc: string): boolean {
  const lower = desc.toLowerCase();
  return lower.includes('service') || lower.includes('jasa');
}

function inferLevel(code: string): 'HS2' | 'HS4' | 'HS6' | null {
  if (code.length === 2) return 'HS2';
  if (code.length === 4) return 'HS4';
  if (code.length === 6) return 'HS6';
  return null;
}

function computeParent(code: string, level: 'HS2' | 'HS4' | 'HS6'): string | null {
  if (level === 'HS2') return null; // HS2 has no parent
  if (level === 'HS4') return code.substring(0, 2); // HS4 parent is HS2
  if (level === 'HS6') return code.substring(0, 4); // HS6 parent is HS4
  return null;
}

function main() {
  console.log('Reading CSV from:', INPUT_CSV);

  const csvContent = fs.readFileSync(INPUT_CSV, 'utf-8');
  const rows = parseCSV(csvContent);

  const seen = new Set<string>();
  let cleanData: CleanHSCode[] = [];

  let totalRows = 0;
  let skippedService = 0;
  let skippedInvalidLength = 0;
  let skippedPlaceholder = 0;
  let skippedDuplicate = 0;
  let skippedMalformed = 0;

  // Skip header row
  for (let i = 1; i < rows.length; i++) {
    totalRows++;
    const parts = rows[i];

    if (parts.length < 9) {
      skippedMalformed++;
      console.warn(`Row ${i + 1}: Expected 9 columns, got ${parts.length}`);
      continue;
    }

    const raw: RawHSCode = {
      hs_code: parts[0].trim(),
      level: parts[1].trim(),
      hs2: parts[2].trim(),
      hs4: parts[3].trim(),
      hs6: parts[4].trim(),
      hs8: parts[5].trim(),
      hs10: parts[6].trim(),
      english_description: parts[7].trim(),
      indonesian_description: parts[8].trim(),
    };

    // Filter 1: Exclude placeholder codes
    if (raw.hs_code === '000000' || raw.hs_code === '') {
      skippedPlaceholder++;
      continue;
    }

    // Filter 2: Exclude services
    if (isServiceDescription(raw.english_description) ||
        isServiceDescription(raw.indonesian_description)) {
      skippedService++;
      continue;
    }

    // Filter 3: Validate code length (must be HS2/HS4/HS6)
    const level = inferLevel(raw.hs_code);
    if (!level) {
      skippedInvalidLength++;
      continue;
    }

    // Filter 4: Deduplicate (first occurrence wins)
    if (seen.has(raw.hs_code)) {
      skippedDuplicate++;
      continue;
    }
    seen.add(raw.hs_code);

    // Compute parent reference
    const parentCode = computeParent(raw.hs_code, level);

    cleanData.push({
      code: raw.hs_code,
      level,
      parent_code: parentCode,
      description_en: raw.english_description || 'N/A',
      description_id: raw.indonesian_description || raw.english_description || 'N/A',
      jurisdiction: 'ID',
      version_year: 2022,
    });
  }

  // Generate HS2 and HS4 codes from HS6 codes
  const hs2Codes = new Map<string, CleanHSCode>();
  const hs4Codes = new Map<string, CleanHSCode>();

  for (const hs6 of cleanData) {
    // Generate HS4 parent
    const hs4Code = hs6.code.substring(0, 4);
    if (!hs4Codes.has(hs4Code)) {
      hs4Codes.set(hs4Code, {
        code: hs4Code,
        level: 'HS4',
        parent_code: hs4Code.substring(0, 2),
        description_en: `HS4: ${hs4Code}`,
        description_id: `HS4: ${hs4Code}`,
        jurisdiction: 'ID',
        version_year: 2022,
      });
    }

    // Generate HS2 grandparent
    const hs2Code = hs6.code.substring(0, 2);
    if (!hs2Codes.has(hs2Code)) {
      hs2Codes.set(hs2Code, {
        code: hs2Code,
        level: 'HS2',
        parent_code: null,
        description_en: `HS2: ${hs2Code}`,
        description_id: `HS2: ${hs2Code}`,
        jurisdiction: 'ID',
        version_year: 2022,
      });
    }
  }

  // Combine all codes (HS2 + HS4 + HS6)
  const allCodes = [
    ...Array.from(hs2Codes.values()),
    ...Array.from(hs4Codes.values()),
    ...cleanData,
  ];

  // Sort by code for consistent output
  allCodes.sort((a, b) => a.code.localeCompare(b.code));
  cleanData = allCodes;

  // Write output CSV
  const outputLines = [
    'code,level,parent_code,description_en,description_id,jurisdiction,version_year',
    ...cleanData.map(row =>
      `${row.code},${row.level},${row.parent_code || ''},${escapeCsv(row.description_en)},${escapeCsv(row.description_id)},${row.jurisdiction},${row.version_year}`
    )
  ];

  fs.writeFileSync(OUTPUT_CSV, outputLines.join('\n'), 'utf-8');

  // Print summary
  console.log('\n=== Processing Summary ===');
  console.log(`Total input rows: ${totalRows}`);
  console.log(`Skipped (services): ${skippedService}`);
  console.log(`Skipped (invalid length): ${skippedInvalidLength}`);
  console.log(`Skipped (placeholder): ${skippedPlaceholder}`);
  console.log(`Skipped (duplicates): ${skippedDuplicate}`);
  console.log(`Skipped (malformed): ${skippedMalformed}`);
  console.log(`\nClean rows written: ${cleanData.length}`);
  console.log(`  HS2: ${cleanData.filter(r => r.level === 'HS2').length}`);
  console.log(`  HS4: ${cleanData.filter(r => r.level === 'HS4').length}`);
  console.log(`  HS6: ${cleanData.filter(r => r.level === 'HS6').length}`);
  console.log(`\nOutput written to: ${OUTPUT_CSV}`);

  // Spot checks
  const sample940500 = cleanData.find(r => r.code === '940500');
  if (sample940500) {
    console.log('\n=== Spot Check: 940500 ===');
    console.log(JSON.stringify(sample940500, null, 2));
  }

  const sample94 = cleanData.find(r => r.code === '94');
  if (sample94) {
    console.log('\n=== Spot Check: 94 (HS2) ===');
    console.log(JSON.stringify(sample94, null, 2));
  }

  const sample9405 = cleanData.find(r => r.code === '9405');
  if (sample9405) {
    console.log('\n=== Spot Check: 9405 (HS4) ===');
    console.log(JSON.stringify(sample9405, null, 2));
  }
}

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

main();
