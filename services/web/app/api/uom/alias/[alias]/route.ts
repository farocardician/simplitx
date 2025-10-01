import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function DELETE(
  req: NextRequest,
  { params }: { params: { alias: string } }
) {
  try {
    const alias = decodeURIComponent(params.alias);

    // Check if alias exists
    const existing = await prisma.uomAlias.findUnique({
      where: { alias },
      include: { uom: true }
    });

    if (!existing) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Alias not found' } },
        { status: 404 }
      );
    }

    // Prevent deleting primary aliases
    if (existing.isPrimary) {
      return NextResponse.json(
        { error: { code: 'CANNOT_DELETE_PRIMARY', message: 'Cannot delete primary aliases (UOM code or name)' } },
        { status: 400 }
      );
    }

    // Delete alias
    await prisma.uomAlias.delete({
      where: { alias }
    });

    return NextResponse.json({ success: true, deleted: alias });

  } catch (error) {
    console.error('Error deleting alias:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to delete alias' } },
      { status: 500 }
    );
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: { alias: string } }
) {
  try {
    const alias = decodeURIComponent(params.alias);

    const aliasRecord = await prisma.uomAlias.findUnique({
      where: { alias },
      include: { uom: true }
    });

    if (!aliasRecord) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Alias not found' } },
        { status: 404 }
      );
    }

    // TODO: In the future, track actual usage by querying parser_results
    // For now, return mock data
    const usageCount = 0;
    const lastUsed = null;

    return NextResponse.json({
      alias: aliasRecord.alias,
      uomCode: aliasRecord.uom.code,
      uomName: aliasRecord.uom.name,
      isPrimary: aliasRecord.isPrimary,
      usageCount,
      lastUsed,
      createdAt: aliasRecord.createdAt
    });

  } catch (error) {
    console.error('Error fetching alias stats:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch alias stats' } },
      { status: 500 }
    );
  }
}
