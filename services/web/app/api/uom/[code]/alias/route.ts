import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { normalizeUom, invalidateUomCache } from '@/lib/uomResolver';

export async function POST(
  req: NextRequest,
  { params }: { params: { code: string } }
) {
  try {
    const uomCode = params.code;
    const body = await req.json();
    const { alias } = body;

    if (!alias) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Alias is required' } },
        { status: 400 }
      );
    }

    // Normalize alias using standard normalization
    const normalized = normalizeUom(alias);

    // Validate format
    if (!normalized || normalized.length > 50) {
      return NextResponse.json(
        { error: { code: 'INVALID_ALIAS', message: 'Invalid alias format (max 50 characters)' } },
        { status: 400 }
      );
    }

    if (!/^[A-Z0-9.\s\-]+$/.test(normalized)) {
      return NextResponse.json(
        { error: { code: 'INVALID_ALIAS', message: 'Alias can only contain letters, numbers, dots, spaces, and hyphens' } },
        { status: 400 }
      );
    }

    // Check if UOM exists
    const uom = await prisma.unitOfMeasure.findUnique({
      where: { code: uomCode }
    });

    if (!uom) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'UOM not found' } },
        { status: 404 }
      );
    }

    // Check if alias already exists
    const existing = await prisma.uomAlias.findUnique({
      where: { alias: normalized },
      include: { uom: true }
    });

    if (existing) {
      if (existing.uomCode === uomCode) {
        return NextResponse.json(
          { error: { code: 'DUPLICATE_ALIAS', message: `Alias "${normalized}" already exists for this UOM` } },
          { status: 409 }
        );
      } else {
        return NextResponse.json(
          {
            error: {
              code: 'ALIAS_CONFLICT',
              message: `Alias "${normalized}" already points to ${existing.uom.name} (${existing.uom.code})`,
              conflictsWith: existing.uomCode
            }
          },
          { status: 409 }
        );
      }
    }

    // Create alias
    const newAlias = await prisma.uomAlias.create({
      data: {
        alias: normalized,
        uomCode,
        isPrimary: false
      },
      include: { uom: true }
    });

    // Invalidate cache immediately
    invalidateUomCache();

    return NextResponse.json(newAlias, { status: 201 });

  } catch (error) {
    console.error('Error adding alias:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to add alias' } },
      { status: 500 }
    );
  }
}
