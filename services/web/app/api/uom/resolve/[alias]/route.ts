import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(
  req: NextRequest,
  { params }: { params: { alias: string } }
) {
  try {
    const inputAlias = params.alias;

    if (!inputAlias) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Alias parameter is required' } },
        { status: 400 }
      );
    }

    // Normalize to uppercase for case-insensitive lookup
    const normalizedAlias = inputAlias.trim().toUpperCase();

    // Lookup alias
    const aliasRecord = await prisma.uomAlias.findUnique({
      where: { alias: normalizedAlias },
      include: { uom: true }
    });

    if (!aliasRecord) {
      return NextResponse.json(
        {
          error: {
            code: 'NOT_FOUND',
            message: `UOM alias "${inputAlias}" not recognized`,
            suggestion: 'Use GET /api/uom to see available UOMs'
          }
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      input: inputAlias,
      normalized: normalizedAlias,
      resolved: {
        code: aliasRecord.uom.code,
        name: aliasRecord.uom.name
      },
      isPrimary: aliasRecord.isPrimary
    });

  } catch (error) {
    console.error('Error resolving UOM alias:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve UOM alias' } },
      { status: 500 }
    );
  }
}
