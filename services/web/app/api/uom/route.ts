import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { invalidateUomCache, normalizeUom } from '@/lib/uomResolver';

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const search = searchParams.get('search');
    const limit = searchParams.get('limit');

    // Build where clause for search
    const where = search && search.length >= 2
      ? {
          OR: [
            { code: { contains: search, mode: 'insensitive' as const } },
            { name: { contains: search, mode: 'insensitive' as const } },
            { aliases: { some: { alias: { contains: search, mode: 'insensitive' as const } } } }
          ]
        }
      : undefined;

    const uoms = await prisma.unitOfMeasure.findMany({
      where,
      include: {
        aliases: {
          orderBy: [
            { isPrimary: 'desc' },
            { alias: 'asc' }
          ]
        }
      },
      orderBy: { name: 'asc' },
      take: limit ? parseInt(limit) : undefined
    });

    return NextResponse.json(uoms);
  } catch (error) {
    console.error('Error fetching UOMs:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch UOM list' } },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { code, name, aliases } = body;

    // Validate required fields
    if (!code || !name) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Code and name are required' } },
        { status: 400 }
      );
    }

    // Normalize code and name using standard normalization
    const normalizedCode = normalizeUom(code);
    const normalizedName = name.trim();

    // Validate code format
    if (!/^[A-Z0-9.\-]+$/.test(normalizedCode)) {
      return NextResponse.json(
        { error: { code: 'INVALID_CODE', message: 'Code can only contain letters, numbers, dots, and hyphens' } },
        { status: 400 }
      );
    }

    // Check if code already exists
    const existing = await prisma.unitOfMeasure.findUnique({
      where: { code: normalizedCode }
    });

    if (existing) {
      return NextResponse.json(
        { error: { code: 'DUPLICATE_CODE', message: `UOM code "${normalizedCode}" already exists` } },
        { status: 409 }
      );
    }

    // Create UOM with aliases
    const aliasesToCreate = [
      { alias: normalizedCode, isPrimary: true },
      { alias: normalizedName.toUpperCase(), isPrimary: true }
    ];

    // Add additional aliases if provided
    if (Array.isArray(aliases) && aliases.length > 0) {
      for (const alias of aliases) {
        const normalized = normalizeUom(alias);
        if (normalized && !aliasesToCreate.some(a => a.alias === normalized)) {
          aliasesToCreate.push({ alias: normalized, isPrimary: false });
        }
      }
    }

    const uom = await prisma.unitOfMeasure.create({
      data: {
        code: normalizedCode,
        name: normalizedName,
        aliases: {
          createMany: {
            data: aliasesToCreate,
            skipDuplicates: true
          }
        }
      },
      include: {
        aliases: true
      }
    });

    // Invalidate cache immediately
    invalidateUomCache();

    return NextResponse.json(uom, { status: 201 });

  } catch (error: any) {
    console.error('Error creating UOM:', error);

    if (error.code === 'P2002') {
      return NextResponse.json(
        { error: { code: 'DUPLICATE_ALIAS', message: 'One or more aliases already exist' } },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to create UOM' } },
      { status: 500 }
    );
  }
}
