import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { invalidateLiveIndex } from '@/lib/productIndexer';

type RouteContext = {
  params: {
    id: string;
  };
};

/**
 * GET /api/products/:id/aliases
 *
 * Get all aliases for a product
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const { id } = context.params;

    const aliases = await prisma.productAlias.findMany({
      where: {
        productId: id,
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return NextResponse.json(aliases);
  } catch (error) {
    console.error('Error fetching aliases:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch aliases' } },
      { status: 500 }
    );
  }
}

/**
 * POST /api/products/:id/aliases
 *
 * Create a new alias for a product
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const { id } = context.params;
    const { aliasDescription, createdBy } = await req.json();

    // Validation
    if (!aliasDescription || typeof aliasDescription !== 'string' || aliasDescription.trim().length === 0) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'aliasDescription is required' } },
        { status: 400 }
      );
    }

    // Check if product exists
    const product = await prisma.product.findUnique({
      where: { id, deletedAt: null },
    });

    if (!product) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Product not found' } },
        { status: 404 }
      );
    }

    // Check for duplicate alias (case-insensitive)
    const duplicate = await prisma.productAlias.findFirst({
      where: {
        productId: id,
        aliasDescription: {
          equals: aliasDescription.trim(),
          mode: 'insensitive',
        },
        deletedAt: null,
      },
    });

    if (duplicate) {
      return NextResponse.json(
        { error: { code: 'DUPLICATE', message: 'This alias already exists for this product' } },
        { status: 409 }
      );
    }

    // Check if alias matches main product description
    if (product.description.toLowerCase() === aliasDescription.trim().toLowerCase()) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Alias cannot be the same as product description' } },
        { status: 400 }
      );
    }

    // Create alias
    const alias = await prisma.productAlias.create({
      data: {
        productId: id,
        aliasDescription: aliasDescription.trim(),
        status: 'active',
        createdBy: createdBy || 'admin',
      },
    });

    // Invalidate live index
    invalidateLiveIndex();

    return NextResponse.json(alias, { status: 201 });
  } catch (error) {
    console.error('Error creating alias:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to create alias' } },
      { status: 500 }
    );
  }
}
