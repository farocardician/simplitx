import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { invalidateLiveIndex } from '@/lib/productIndexer';
import type { HsCodeType } from '@prisma/client';

/**
 * GET /api/products
 *
 * Lists active products with search, filtering, sorting, and pagination
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    // Pagination
    const page = parseInt(searchParams.get('page') || '1', 10);
    const pageSize = parseInt(searchParams.get('pageSize') || '20', 10);

    if (page < 1 || pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'invalid pagination parameters' } },
        { status: 400 }
      );
    }

    // Search
    const search = searchParams.get('search')?.trim();

    // Filters
    const status = searchParams.get('status');
    const type = searchParams.get('type');
    const uomCode = searchParams.get('uomCode');

    // Sorting
    const sortBy = searchParams.get('sortBy') || 'createdAt';
    const sortOrder = searchParams.get('sortOrder') || 'desc';

    if (!['asc', 'desc'].includes(sortOrder)) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'sortOrder must be asc or desc' } },
        { status: 400 }
      );
    }

    // Build where clause
    const where: any = {
      deletedAt: null, // Only non-deleted products
    };

    if (status && ['active', 'inactive'].includes(status)) {
      where.status = status;
    }

    if (type && ['BARANG', 'JASA'].includes(type)) {
      where.type = type;
    }

    if (uomCode) {
      where.uomCode = uomCode;
    }

    if (search) {
      where.description = {
        contains: search,
        mode: 'insensitive',
      };
    }

    // Build orderBy clause
    const orderBy: any = {};
    if (sortBy === 'description' || sortBy === 'createdAt' || sortBy === 'updatedAt') {
      orderBy[sortBy] = sortOrder;
    } else {
      orderBy.createdAt = 'desc';
    }

    // Query products
    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: {
          uom: true,
          aliases: {
            where: {
              status: 'active',
              deletedAt: null,
            },
          },
        },
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.product.count({ where }),
    ]);

    return NextResponse.json({
      products,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });

  } catch (error) {
    console.error('Error listing products:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to list products' } },
      { status: 500 }
    );
  }
}

/**
 * POST /api/products
 *
 * Creates a new active product
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { description, hsCode, type, uomCode, status, createdBy } = body;

    // Validation
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'description is required' } },
        { status: 400 }
      );
    }

    if (description.trim().length > 500) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'description must be 500 characters or less' } },
        { status: 400 }
      );
    }

    if (hsCode && (typeof hsCode !== 'string' || !/^\d{6}$/.test(hsCode))) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'hsCode must be a 6-digit number' } },
        { status: 400 }
      );
    }

    if (type && !['BARANG', 'JASA'].includes(type)) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'type must be BARANG or JASA' } },
        { status: 400 }
      );
    }

    if (status && !['active', 'inactive'].includes(status)) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'status must be active or inactive' } },
        { status: 400 }
      );
    }

    // Check for duplicate description (case-insensitive)
    const existing = await prisma.product.findFirst({
      where: {
        description: {
          equals: description.trim(),
          mode: 'insensitive',
        },
        deletedAt: null,
      },
    });

    if (existing) {
      return NextResponse.json(
        { error: { code: 'DUPLICATE', message: 'A product with this description already exists' } },
        { status: 409 }
      );
    }

    // Verify UOM exists if provided
    if (uomCode) {
      const uomExists = await prisma.unitOfMeasure.findUnique({
        where: { code: uomCode },
      });

      if (!uomExists) {
        return NextResponse.json(
          { error: { code: 'NOT_FOUND', message: 'UOM code not found' } },
          { status: 404 }
        );
      }
    }

    // Create product
    const product = await prisma.product.create({
      data: {
        description: description.trim(),
        hsCode: hsCode || null,
        type: type as HsCodeType || null,
        uomCode: uomCode || null,
        status: status || 'active',
        createdBy: createdBy || null,
      },
      include: {
        uom: true,
        aliases: true,
      },
    });

    // Invalidate live index (will refresh on next search)
    invalidateLiveIndex();

    return NextResponse.json(product, { status: 201 });

  } catch (error: any) {
    console.error('Error creating product:', error);

    // Handle Prisma errors
    if (error.code === 'P2003') {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Referenced UOM not found' } },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to create product' } },
      { status: 500 }
    );
  }
}
