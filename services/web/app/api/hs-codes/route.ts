import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { computeStatus, expectedParent, inferLevel, isDigitsOnlySearch, isValidHsCode, normalizeHsCode } from '@/lib/hsCodes';
import { Prisma } from '@prisma/client';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type LevelFilter = 'all' | 'HS2' | 'HS4' | 'HS6';

export async function GET(req: NextRequest) {
  try {
    const hsDelegate = (prisma as any).hsCode;
    if (!hsDelegate?.findMany) {
      return NextResponse.json(
        {
          error: {
            code: 'PRISMA_CLIENT_OUTDATED',
            message: 'HS codes schema is not generated yet. Run `npx prisma generate` (and apply the hs_codes migration) then restart the server.'
          }
        },
        { status: 503 }
      );
    }

    const { searchParams } = req.nextUrl;
    const search = (searchParams.get('search') ?? '').trim();
    const jurisdiction = (searchParams.get('jurisdiction') ?? 'ID').toUpperCase();
    const versionYear = parseInt(searchParams.get('versionYear') ?? '2022', 10);
    const levelParam = (searchParams.get('level') ?? 'all').toUpperCase() as LevelFilter;
    const statusParam = (searchParams.get('status') ?? 'active').toLowerCase() as 'active' | 'expired' | 'all';
    const cursor = searchParams.get('cursor');
    const limitParam = parseInt(searchParams.get('limit') ?? `${DEFAULT_LIMIT}`, 10);
    const limit = Math.max(1, Math.min(isNaN(limitParam) ? DEFAULT_LIMIT : limitParam, MAX_LIMIT));

    const where: Prisma.HsCodeWhereInput = {
      jurisdiction,
      versionYear
    };
    const andConditions: Prisma.HsCodeWhereInput[] = [];

    if (levelParam === 'HS2' || levelParam === 'HS4' || levelParam === 'HS6') {
      where.level = levelParam;
    }

    if (statusParam !== 'all') {
      const now = new Date();
      if (statusParam === 'active') {
        andConditions.push({
          OR: [
            { validFrom: null },
            { validFrom: { lte: now } }
          ]
        });
        andConditions.push({
          OR: [
            { validTo: null },
            { validTo: { gte: now } }
          ]
        });
      } else if (statusParam === 'expired') {
        andConditions.push({
          OR: [
            { validTo: { lt: now } },
            { validFrom: { gt: now } }
          ]
        });
      }
    }

    if (search.length > 0) {
      if (isDigitsOnlySearch(search)) {
        andConditions.push({ code: { startsWith: search } });
      } else {
        const normalized = search.toLowerCase();
        andConditions.push({
          OR: [
            { descriptionEn: { contains: normalized, mode: 'insensitive' } },
            { descriptionId: { contains: normalized, mode: 'insensitive' } }
          ]
        });
      }
    }

    if (andConditions.length > 0) {
      where.AND = [...(where.AND ?? []), ...andConditions];
    }

    const orderBy: Prisma.HsCodeOrderByWithRelationInput[] = [];

    if (search && isDigitsOnlySearch(search)) {
      orderBy.push({ code: 'asc' });
    } else if (search) {
      // Sort by relevance approximated via updatedAt desc then code
      orderBy.push({ updatedAt: 'desc' });
    }

    orderBy.push({ code: 'asc' });

    const queryOptions: Prisma.HsCodeFindManyArgs = {
      where,
      orderBy,
      take: limit + 1,
    };

    if (cursor) {
      queryOptions.skip = 1;
      queryOptions.cursor = { id: cursor };
    }

    const records = await hsDelegate.findMany(queryOptions);

    const hasNext = records.length > limit;
    const items = hasNext ? records.slice(0, -1) : records;

    const data = items.map(record => ({
      id: record.id,
      code: record.code,
      level: record.level,
      jurisdiction: record.jurisdiction,
      versionYear: record.versionYear,
      parentCode: record.parentCode,
      descriptionEn: record.descriptionEn,
      descriptionId: record.descriptionId,
      notes: record.notes,
      validFrom: record.validFrom,
      validTo: record.validTo,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      status: computeStatus(record.validFrom, record.validTo)
    }));

    return NextResponse.json({
      items: data,
      nextCursor: hasNext ? records[records.length - 1].id : null
    });
  } catch (error: any) {
    if (error?.code === 'P2021') {
      return NextResponse.json(
        {
          error: {
            code: 'TABLE_MISSING',
            message: 'The hs_codes table is missing. Run the prisma migration to create it.'
          }
        },
        { status: 503 }
      );
    }

    console.error('Error fetching HS codes:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch HS codes' } },
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
            message: 'HS codes schema is not generated yet. Run `npx prisma generate` (and apply the hs_codes migration) then restart the server.'
          }
        },
        { status: 503 }
      );
    }

    const body = await req.json();
    const rawCode: string = body.code;
    const descriptionEn: string = body.descriptionEn;
    const descriptionId: string = body.descriptionId;
    const jurisdiction = (body.jurisdiction ?? 'ID').toUpperCase();
    const versionYear = parseInt(body.versionYear ?? 2022, 10);
    const notes = body.notes ? String(body.notes).trim() : null;
    const validFromRaw = body.validFrom ? new Date(body.validFrom) : null;
    const validToRaw = body.validTo ? new Date(body.validTo) : null;

    if (!rawCode || !descriptionEn || !descriptionId) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Code, English description, and Indonesian description are required.' } },
        { status: 400 }
      );
    }

    const code = normalizeHsCode(rawCode);

    if (!isValidHsCode(code)) {
      return NextResponse.json(
        { error: { code: 'INVALID_CODE', message: 'Code must be numeric and 2, 4, or 6 digits long.' } },
        { status: 400 }
      );
    }

    const level = inferLevel(code);
    if (!level) {
      return NextResponse.json(
        { error: { code: 'INVALID_LEVEL', message: 'Unable to infer HS level from code length.' } },
        { status: 400 }
      );
    }

    if (validFromRaw && isNaN(validFromRaw.getTime())) {
      return NextResponse.json(
        { error: { code: 'INVALID_DATE', message: 'Valid from date is invalid.' } },
        { status: 400 }
      );
    }

    if (validToRaw && isNaN(validToRaw.getTime())) {
      return NextResponse.json(
        { error: { code: 'INVALID_DATE', message: 'Valid to date is invalid.' } },
        { status: 400 }
      );
    }

    if (validFromRaw && validToRaw && validFromRaw > validToRaw) {
      return NextResponse.json(
        { error: { code: 'INVALID_DATE_RANGE', message: 'Valid to date must be after valid from.' } },
        { status: 400 }
      );
    }

    const parentCode = body.parentCode
      ? normalizeHsCode(body.parentCode)
      : expectedParent(code, level) ?? null;

    if ((level === 'HS4' || level === 'HS6') && !parentCode) {
      return NextResponse.json(
        { error: { code: 'PARENT_REQUIRED', message: 'Parent code is required for HS4/HS6 entries.' } },
        { status: 400 }
      );
    }

    if (level !== 'HS2' && parentCode) {
      const parentLevel = level === 'HS4' ? 'HS2' : 'HS4';
      if (expectedParent(code, level) !== parentCode) {
        return NextResponse.json(
          { error: { code: 'INVALID_PARENT', message: `Parent code must match ${parentLevel} prefix.` } },
          { status: 400 }
        );
      }

      const parentExists = await hsDelegate.findFirst({
        where: {
          jurisdiction,
          versionYear,
          code: parentCode
        }
      });

      if (!parentExists) {
        return NextResponse.json(
          { error: { code: 'PARENT_MISSING', message: `${parentCode} is missing. Create the parent now?`, meta: { parentCode } } },
          { status: 409 }
        );
      }
    }

    const existing = await hsDelegate.findFirst({
      where: { jurisdiction, versionYear, code }
    });

    if (existing) {
      return NextResponse.json(
        { error: { code: 'DUPLICATE', message: 'That code already exists. Opening it for you…', meta: { id: existing.id } } },
        { status: 409 }
      );
    }

    const created = await hsDelegate.create({
      data: {
        code,
        level,
        jurisdiction,
        versionYear,
        parentCode,
        descriptionEn: descriptionEn.trim(),
        descriptionId: descriptionId.trim(),
        notes,
        validFrom: validFromRaw,
        validTo: validToRaw
      }
    });

    return NextResponse.json({
      ...created,
      status: computeStatus(created.validFrom, created.validTo)
    }, { status: 201 });
  } catch (error: any) {
    if (error?.code === 'P2021') {
      return NextResponse.json(
        {
          error: {
            code: 'TABLE_MISSING',
            message: 'The hs_codes table is missing. Run the prisma migration to create it.'
          }
        },
        { status: 503 }
      );
    }

    console.error('Error creating HS code:', error);

    if (error?.code === 'P2002') {
      return NextResponse.json(
        { error: { code: 'DUPLICATE', message: 'That code already exists. Opening it for you…' } },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to create HS code.' } },
      { status: 500 }
    );
  }
}
