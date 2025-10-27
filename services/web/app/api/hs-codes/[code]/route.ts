import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  expectedParent,
  normalizeHsCode,
  padHsCodeToSix,
  type HsLevel,
  type HsType
} from '@/lib/hsCodes';

function parseTypeParam(value: string | null): HsType | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === 'BARANG' || normalized === 'A') return 'BARANG';
  if (normalized === 'JASA' || normalized === 'B') return 'JASA';
  return null;
}

function mapRecord(record: any) {
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
    parentCode: expectedParent(record.code),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

async function buildBreadcrumbs(record: any) {
  const breadcrumbs: Array<{ code: string; level: HsLevel; descriptionEn: string; type: HsType }> = [];
  let currentParentId = record.parentId as string | null;

  while (currentParentId) {
    const parent = await prisma.hsCode.findUnique({
      where: { id: currentParentId },
      select: {
        id: true,
        code: true,
        level: true,
        descriptionEn: true,
        type: true,
        parentId: true
      }
    });

    if (!parent) break;
    breadcrumbs.unshift({ code: parent.code, level: parent.level, descriptionEn: parent.descriptionEn, type: parent.type as HsType });
    currentParentId = parent.parentId as string | null;
  }

  return breadcrumbs;
}

export async function GET(req: NextRequest, { params }: { params: { code: string } }) {
  try {
    const type = parseTypeParam(req.nextUrl.searchParams.get('type'));
    if (!type) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Query parameter `type=barang|jasa` is required.' } },
        { status: 400 }
      );
    }

    const normalized = normalizeHsCode(params.code);
    const code = padHsCodeToSix(normalized);

    const record = await prisma.hsCode.findFirst({
      where: { code, type }
    });

    if (!record) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'HS code not found for the requested type.' } },
        { status: 404 }
      );
    }

    const breadcrumbs = await buildBreadcrumbs(record);

    return NextResponse.json({
      record: { ...mapRecord(record), status: 'active' as const },
      breadcrumbs
    });
  } catch (error) {
    console.error('Error fetching HS code detail:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to load HS code.' } },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { code: string } }) {
  try {
    const type = parseTypeParam(req.nextUrl.searchParams.get('type'));
    if (!type) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Query parameter `type=barang|jasa` is required.' } },
        { status: 400 }
      );
    }

    const normalized = normalizeHsCode(params.code);
    const code = padHsCodeToSix(normalized);

    const existing = await prisma.hsCode.findFirst({
      where: { code, type }
    });

    if (!existing) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'HS code not found for the requested type.' } },
        { status: 404 }
      );
    }

    const body = await req.json();
    const descriptionEn = body.descriptionEn !== undefined ? String(body.descriptionEn).trim() : undefined;
    const descriptionId = body.descriptionId !== undefined ? String(body.descriptionId).trim() : undefined;
    const updatedAt = body.updatedAt ? new Date(body.updatedAt) : null;

    if (descriptionEn !== undefined && !descriptionEn) {
      return NextResponse.json(
        { error: { code: 'INVALID_DESCRIPTION', message: 'English description cannot be empty.' } },
        { status: 400 }
      );
    }

    if (descriptionId !== undefined && !descriptionId) {
      return NextResponse.json(
        { error: { code: 'INVALID_DESCRIPTION', message: 'Indonesian description cannot be empty.' } },
        { status: 400 }
      );
    }

    if (updatedAt && existing.updatedAt.toISOString() !== updatedAt.toISOString()) {
      return NextResponse.json(
        { error: { code: 'CONFLICT', message: 'Record was updated elsewhere. Refresh to continue.', meta: mapRecord(existing) } },
        { status: 409 }
      );
    }

    const updated = await prisma.hsCode.update({
      where: { id: existing.id },
      data: {
        ...(descriptionEn !== undefined ? { descriptionEn } : {}),
        ...(descriptionId !== undefined ? { descriptionId } : {})
      }
    });

    return NextResponse.json({ ...mapRecord(updated), status: 'active' as const });
  } catch (error) {
    console.error('Error updating HS code:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to update HS code.' } },
      { status: 500 }
    );
  }
}
