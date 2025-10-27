#!/usr/bin/env node

// Imports HS codes from the official Barang and Jasa CSV datasets
// and seeds the database using the revamped Prisma schema.

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const CSV_FILES = [
  { file: path.resolve(__dirname, '../../../context/CODE_OF_GOODS_BARANG.csv'), type: 'BARANG' },
  { file: path.resolve(__dirname, '../../../context/CODE_OF_GOODS_JASA.csv'), type: 'JASA' },
];

const LEVEL_ORDER = { HS2: 0, HS4: 1, HS6: 2 };

function parseCsv(content) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];

    if (char === '\r') {
      continue;
    }

    if (char === '\\' && inQuotes) {
      const next = content[i + 1];
      if (next === '"' || next === '\\') {
        field += next;
        i += 1;
        continue;
      }
    }

    if (char === '"') {
      if (inQuotes) {
        const next = content[i + 1];
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        inQuotes = true;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\n' && !inQuotes) {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function determineLevel(chapter, group) {
  if (chapter === '00' && group === '00') {
    return 'HS2';
  }
  if (group === '00') {
    return 'HS4';
  }
  return 'HS6';
}

function parentCodeFor(level, code) {
  if (level === 'HS2') return null;
  if (level === 'HS4') {
    return `${code.slice(0, 2)}0000`;
  }
  return `${code.slice(0, 4)}00`;
}

function cleanCell(value) {
  return value.replace(/^[\s\uFEFF]+|[\s\uFEFF]+$/g, '');
}

function normalizeCode(section, chapter, group) {
  const sec = section.padStart(2, '0');
  const chap = chapter.padStart(2, '0');
  const grp = group.padStart(2, '0');
  return `${sec}${chap}${grp}`;
}

function parseDataset(filePath, type) {
  const content = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(content);
  if (!rows.length) {
    throw new Error(`Dataset ${filePath} is empty.`);
  }

  const header = rows[0];
  if (header.length < 6) {
    throw new Error(`Unexpected header in ${filePath}. Got: ${header.join(',')}`);
  }

  const records = [];

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.length === 0 || row.every((cell) => cell.trim() === '')) {
      continue;
    }

    const goodsServices = cleanCell(row[0] || '');
    const sectionRaw = cleanCell(row[1] || '');
    const chapterRaw = cleanCell(row[2] || '');
    const groupRaw = cleanCell(row[3] || '');
    const english = cleanCell(row[4] || '');
    const indonesian = cleanCell(row[5] || '');

    if (!sectionRaw || sectionRaw === '00') {
      // Skip top-level summary rows (e.g., Goods / Services)
      continue;
    }

    const section = sectionRaw.padStart(2, '0');
    const chapter = chapterRaw.padStart(2, '0');
    const group = groupRaw.padStart(2, '0');

    const code = normalizeCode(section, chapter, group);
    const level = determineLevel(chapter, group);
    const parentCode = parentCodeFor(level, code);

    const datasetType = goodsServices.startsWith('A') ? 'BARANG' : goodsServices.startsWith('B') ? 'JASA' : type;
    if (datasetType !== type) {
      console.warn(`Row type mismatch in ${filePath} line ${i + 1}: expected ${type}, saw ${datasetType}. Using ${type}.`);
    }

    records.push({
      type,
      section,
      chapter,
      group,
      code,
      level,
      parentCode,
      descriptionEn: english,
      descriptionId: indonesian,
    });
  }

  return records;
}

async function seedHsCodes(dataset) {
  let existingCount = 0;
  try {
    existingCount = await prisma.hsCode.count();
  } catch (error) {
    console.warn('[seed] hs_codes table not accessible before migration? continuing with empty dataset.');
  }

  console.log(`[seed] Removing existing HS codes (${existingCount} rows).`);
  try {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "hs_codes" RESTART IDENTITY CASCADE');
  } catch (error) {
    console.error('[seed] Unable to truncate hs_codes table. Ensure migrations are applied before seeding.');
    throw error;
  }

  const codeToId = new Map();
  const sorted = [...dataset].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.code.localeCompare(b.code));

  await prisma.$transaction(async (tx) => {
    for (const entry of sorted) {
      const key = `${entry.type}:${entry.code}`;
      if (codeToId.has(key)) {
        throw new Error(`Duplicate HS code detected: ${key}`);
      }

      const parentKey = entry.parentCode ? `${entry.type}:${entry.parentCode}` : null;
      const parentId = parentKey ? codeToId.get(parentKey) : null;

      if (parentKey && !parentId) {
        throw new Error(`Missing parent HS code for ${key} -> expected ${parentKey}`);
      }

      const record = await tx.hsCode.create({
        data: {
          code: entry.code,
          type: entry.type,
          level: entry.level,
          sectionCode: entry.section,
          chapterCode: entry.chapter,
          groupCode: entry.group,
          descriptionEn: entry.descriptionEn,
          descriptionId: entry.descriptionId,
          ...(parentId ? { parent: { connect: { id: parentId } } } : {}),
        },
      });

      codeToId.set(key, record.id);
    }
  });

  console.log(`[seed] Inserted ${sorted.length} HS code rows.`);
}

const SKIP_DB = process.env.SKIP_DB === '1';

async function main() {
  const dataset = [];
  for (const { file, type } of CSV_FILES) {
    console.log(`[seed] Loading ${file}`);
    const records = parseDataset(file, type);
    console.log(`[seed] Parsed ${records.length} rows for ${type.toLowerCase()}.`);
    dataset.push(...records);
  }

  if (SKIP_DB) {
    console.log('[seed] SKIP_DB=1 detected. Parsed data only, database writes skipped.');
    return;
  }

  await seedHsCodes(dataset);
}

main()
  .catch((error) => {
    console.error('[seed] Failed to import HS codes:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
