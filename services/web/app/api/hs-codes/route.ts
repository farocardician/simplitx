import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  expectedParent,
  inferLevel,
  isDigitsOnlySearch,
  isValidHsCode,
  normalizeHsCode,
  padHsCodeToSix,
  splitHsSegments,
  type HsLevel,
  type HsType
} from '@/lib/hsCodes';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const LEVEL_FILTERS: Record<string, HsLevel> = {
  HS2: 'HS2',
  HS4: 'HS4',
  HS6: 'HS6'
};

function parseTypeParam(value: string | null): HsType | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === 'BARANG' || normalized === 'A') return 'BARANG';
  if (normalized === 'JASA' || normalized === 'B') return 'JASA';
  return null;
}

function mapRecord(record: any) {
  const parentCode = expectedParent(record.code);
  return {
    id: record.id,
    code: record.code,
    type: record.type,
    level: record.level,
    sectionCode: record.sectionCode,
    chapterCode: record.chapterCode,
    groupCode: record.groupCode,
    descriptionEn: record.descriptionEn,
    descriptionId: record.descriptionId,
    parentId: record.parentId,
    parentCode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: 'active' as const
  };
}

export async function GET(req: NextRequest) {
  try {
    const hsDelegate = (prisma as any).hsCode;
    if (!hsDelegate?.findMany) {
      return NextResponse.json(
        {
          error: {
            code: 'PRISMA_CLIENT_OUTDATED',
            message: 'HS codes schema is not generated yet. Run `npx prisma generate` after applying the migrations and restart the server.'
          }
        },
        { status: 503 }
      );
    }

    const { searchParams } = req.nextUrl;
    const search = (searchParams.get('search') ?? '').trim();
    const levelParam = (searchParams.get('level') ?? 'all').toUpperCase();
    const typeParam = parseTypeParam(searchParams.get('type'));
    const cursor = searchParams.get('cursor');

    const limitInput = parseInt(searchParams.get('limit') ?? `${DEFAULT_LIMIT}`, 10);
    const limit = Math.max(1, Math.min(Number.isNaN(limitInput) ? DEFAULT_LIMIT : limitInput, MAX_LIMIT));

    const where: Prisma.HsCodeWhereInput = {};
    const andConditions: Prisma.HsCodeWhereInput[] = [];

    if (typeParam) {
      where.type = typeParam;
    }

    if (levelParam in LEVEL_FILTERS) {
      where.level = LEVEL_FILTERS[levelParam];
    }

    if (search) {
      if (isDigitsOnlySearch(search)) {
        const digits = normalizeHsCode(search);
        andConditions.push({ code: { startsWith: digits } });
      } else {
        andConditions.push({
          OR: [
            { descriptionEn: { contains: search, mode: 'insensitive' } },
            { descriptionId: { contains: search, mode: 'insensitive' } }
          ]
        });
      }
    }

    if (andConditions.length) {
      where.AND = andConditions;
    }

    const orderBy: Prisma.HsCodeOrderByWithRelationInput[] = [];
    if (search && !isDigitsOnlySearch(search)) {
      orderBy.push({ updatedAt: 'desc' });
    }
    orderBy.push({ code: 'asc' });

    const query: Prisma.HsCodeFindManyArgs = {
      where,
      orderBy,
      take: limit + 1,
    };

    if (cursor) {
      query.skip = 1;
      query.cursor = { id: cursor };
    }

    const records = await hsDelegate.findMany(query);
    const hasNext = records.length > limit;
    const items = hasNext ? records.slice(0, -1) : records;

    return NextResponse.json({
      items: items.map(mapRecord),
      nextCursor: hasNext ? records[records.length - 1].id : null
    });
  } catch (error: any) {
    if (error?.code === 'P2021') {
      return NextResponse.json(
        {
          error: {
            code: 'TABLE_MISSING',
            message: 'The hs_codes table is missing. Run the Prisma migration to create it.'
          }
        },
        { status: 503 }
      );
    }

    console.error('Error fetching HS codes:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch HS codes.' } },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const hsDelegate = (prisma as any).hsCode;
    if (!hsDelegate?.create) {
      return NextResponse.json(
        {
          error: {
            code: 'PRISMA_CLIENT_OUTDATED',
            message: 'HS codes schema is not generated yet. Run `npx prisma generate` after applying the migrations and restart the server.'
          }
        },
        { status: 503 }
      );
    }

    const body = await req.json();
    const type = parseTypeParam(body.type) ?? null;
    const rawCode = typeof body.code === 'string' ? body.code : '';
    const descriptionEn = typeof body.descriptionEn === 'string' ? body.descriptionEn.trim() : '';
    const descriptionId = typeof body.descriptionId === 'string' ? body.descriptionId.trim() : '';

    if (!type || !rawCode || !descriptionEn || !descriptionId) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Type, code, English description, and Indonesian description are required.' } },
        { status: 400 }
      );
    }

    if (!isValidHsCode(rawCode)) {
      return NextResponse.json(
        { error: { code: 'INVALID_CODE', message: 'Code must be numeric and 2, 4, or 6 digits long.' } },
        { status: 400 }
      );
    }

    const paddedCode = padHsCodeToSix(rawCode);
    const level = inferLevel(paddedCode);
    if (!level) {
      return NextResponse.json(
        { error: { code: 'INVALID_LEVEL', message: 'Unable to infer HS level from the provided code.' } },
        { status: 400 }
      );
    }

    const segments = splitHsSegments(paddedCode);

    const existing = await prisma.hsCode.findFirst({
      where: {
        code: paddedCode,
        type
      }
    });

    if (existing) {
      return NextResponse.json(
        { error: { code: 'DUPLICATE', message: 'HS code already exists for this type.', meta: { id: existing.id } } },
        { status: 409 }
      );
    }

    const parentCode = expectedParent(paddedCode);
    let parentId: string | null = null;

    if (parentCode) {
      const parent = await prisma.hsCode.findFirst({
        where: {
          code: parentCode,
          type
        }
      });

      if (!parent) {
        return NextResponse.json(
          { error: { code: 'PARENT_MISSING', message: `Parent code ${parentCode} is missing for ${type}.`, meta: { parentCode } } },
          { status: 409 }
        );
      }

      parentId = parent.id;
    }

    const created = await prisma.hsCode.create({
      data: {
        code: paddedCode,
        type,
        level,
        sectionCode: segments.section,
        chapterCode: segments.chapter,
        groupCode: segments.group,
        descriptionEn,
        descriptionId,
        ...(parentId ? { parent: { connect: { id: parentId } } } : {})
      }
    });

    return NextResponse.json(mapRecord(created), { status: 201 });
  } catch (error: any) {
    if (error?.code === 'P2021') {
      return NextResponse.json(
        {
          error: {
            code: 'TABLE_MISSING',
            message: 'The hs_codes table is missing. Run the Prisma migration to create it.'
          }
        },
        { status: 503 }
      );
    }

    console.error('Error creating HS code:', error);

    if (error?.code === 'P2002') {
      return NextResponse.json(
        { error: { code: 'DUPLICATE', message: 'HS code already exists for this type.' } },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to create HS code.' } },
      { status: 500 }
    );
  }
}
