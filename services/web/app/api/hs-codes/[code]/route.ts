import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { computeStatus, expectedParent, normalizeHsCode, type HsLevel } from '@/lib/hsCodes';

interface RouteParams {
  params: {
    code: string;
  };
}

function parseJurisdiction(searchParams: URLSearchParams): { jurisdiction: string; versionYear: number } {
  const jurisdiction = (searchParams.get('jurisdiction') ?? 'ID').toUpperCase();
  const versionYear = parseInt(searchParams.get('versionYear') ?? '2022', 10);
  return { jurisdiction, versionYear: Number.isNaN(versionYear) ? 2022 : versionYear };
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const hsDelegate = (prisma as any).hsCode;
    if (!hsDelegate?.findFirst) {
      return NextResponse.json(
        {
          error: {
            code: 'PRISMA_CLIENT_OUTDATED',
            message: 'HS codes schema not generated. Run `npx prisma generate` and apply the hs_codes migration.'
          }
        },
        { status: 503 }
      );
    }

    const { jurisdiction, versionYear } = parseJurisdiction(req.nextUrl.searchParams);
    const codeParam = normalizeHsCode(params.code);

    const record = await hsDelegate.findFirst({
      where: {
        jurisdiction,
        versionYear,
        code: codeParam
      }
    });

    if (!record) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'HS code not found.' } },
        { status: 404 }
      );
    }

    const breadcrumbs: Array<{ code: string; level: string; descriptionEn: string }> = [];

    async function fetchParent(parentCode: string | null) {
      if (!parentCode) return null;
      return hsDelegate.findFirst({
        where: {
          jurisdiction,
          versionYear,
          code: parentCode
        },
        select: {
          code: true,
          level: true,
          descriptionEn: true
        }
      });
    }

    const parent = await fetchParent(record.parentCode);
    if (parent) {
      breadcrumbs.unshift({ code: parent.code, level: parent.level, descriptionEn: parent.descriptionEn });
      if (parent.level === 'HS4') {
        const grandParentCode = expectedParent(parent.code, parent.level as HsLevel);
        if (grandParentCode) {
          const grandParent = await fetchParent(grandParentCode);
          if (grandParent) {
            breadcrumbs.unshift({ code: grandParent.code, level: grandParent.level, descriptionEn: grandParent.descriptionEn });
          }
        }
      }
    }

    return NextResponse.json({
      record: {
        ...record,
        status: computeStatus(record.validFrom, record.validTo)
      },
      breadcrumbs
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

    console.error('Error fetching HS code detail:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to load HS code.' } },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const hsDelegate = (prisma as any).hsCode;
    if (!hsDelegate?.findFirst || !hsDelegate?.updateMany) {
      return NextResponse.json(
        {
          error: {
            code: 'PRISMA_CLIENT_OUTDATED',
            message: 'HS codes schema not generated. Run `npx prisma generate` and apply the hs_codes migration.'
          }
        },
        { status: 503 }
      );
    }

    const body = await req.json();
    const { jurisdiction, versionYear } = parseJurisdiction(req.nextUrl.searchParams);
    const codeParam = normalizeHsCode(params.code);

    const existing = await hsDelegate.findFirst({
      where: {
        jurisdiction,
        versionYear,
        code: codeParam
      }
    });

    if (!existing) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'HS code not found.' } },
        { status: 404 }
      );
    }

    const descriptionEn = body.descriptionEn?.trim();
    const descriptionId = body.descriptionId?.trim();
    const notes = body.notes !== undefined ? String(body.notes).trim() || null : existing.notes;
    const validFrom = body.validFrom ? new Date(body.validFrom) : body.validFrom === null ? null : existing.validFrom;
    const validTo = body.validTo ? new Date(body.validTo) : body.validTo === null ? null : existing.validTo;

    // Check for optimistic locking - compare timestamps
    if (body.updatedAt) {
      const clientUpdatedAt = new Date(body.updatedAt).toISOString();
      const existingUpdatedAt = new Date(existing.updatedAt).toISOString();

      if (clientUpdatedAt !== existingUpdatedAt) {
        return NextResponse.json(
          { error: { code: 'CONFLICT', message: 'Updated elsewhere. Review changes?', meta: { current: existing } } },
          { status: 409 }
        );
      }
    }

    if (body.descriptionEn !== undefined && !descriptionEn) {
      return NextResponse.json(
        { error: { code: 'INVALID_DESCRIPTION', message: 'English description is required.' } },
        { status: 400 }
      );
    }

    if (body.descriptionId !== undefined && !descriptionId) {
      return NextResponse.json(
        { error: { code: 'INVALID_DESCRIPTION', message: 'Indonesian description is required.' } },
        { status: 400 }
      );
    }

    if (validFrom && isNaN(validFrom.getTime())) {
      return NextResponse.json(
        { error: { code: 'INVALID_DATE', message: 'Valid from date is invalid.' } },
        { status: 400 }
      );
    }

    if (validTo && isNaN(validTo.getTime())) {
      return NextResponse.json(
        { error: { code: 'INVALID_DATE', message: 'Valid to date is invalid.' } },
        { status: 400 }
      );
    }

    if (validFrom && validTo && validFrom > validTo) {
      return NextResponse.json(
        { error: { code: 'INVALID_DATE_RANGE', message: 'Valid to date must be after valid from.' } },
        { status: 400 }
      );
    }

    const updateData = {
      descriptionEn: descriptionEn ?? existing.descriptionEn,
      descriptionId: descriptionId ?? existing.descriptionId,
      notes,
      validFrom,
      validTo
    };

    const updated = await hsDelegate.update({
      where: {
        id: existing.id
      },
      data: updateData
    });

    return NextResponse.json({
      ...updated,
      status: computeStatus(updated.validFrom, updated.validTo)
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

    console.error('Error updating HS code:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to update HS code.' } },
      { status: 500 }
    );
  }
}
