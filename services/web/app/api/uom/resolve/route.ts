import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { aliases } = body;

    if (!Array.isArray(aliases) || aliases.length === 0) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'aliases must be a non-empty array' } },
        { status: 400 }
      );
    }

    // Normalize all aliases to uppercase
    const normalizedAliases = aliases.map((a: string) => a.trim().toUpperCase());

    // Bulk lookup
    const aliasRecords = await prisma.uomAlias.findMany({
      where: { alias: { in: normalizedAliases } },
      include: { uom: true }
    });

    // Create lookup map
    const resolvedMap = new Map(
      aliasRecords.map(record => [
        record.alias,
        {
          code: record.uom.code,
          name: record.uom.name,
          isPrimary: record.isPrimary
        }
      ])
    );

    // Build response with both resolved and unresolved
    const results = aliases.map((originalAlias: string) => {
      const normalized = originalAlias.trim().toUpperCase();
      const resolved = resolvedMap.get(normalized);

      return {
        input: originalAlias,
        normalized,
        resolved: resolved || null
      };
    });

    const resolvedCount = results.filter(r => r.resolved !== null).length;
    const unresolvedCount = results.filter(r => r.resolved === null).length;

    return NextResponse.json({
      total: results.length,
      resolved: resolvedCount,
      unresolved: unresolvedCount,
      results
    });

  } catch (error) {
    console.error('Error bulk resolving UOM aliases:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve UOM aliases' } },
      { status: 500 }
    );
  }
}
