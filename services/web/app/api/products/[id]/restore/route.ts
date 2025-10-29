import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { invalidateLiveIndex } from '@/lib/productIndexer';

type RouteContext = {
  params: {
    id: string;
  };
};

/**
 * POST /api/products/:id/restore
 *
 * Restores a soft-deleted product (undo delete)
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const { id } = context.params;

    // Check product exists and is deleted
    const existing = await prisma.product.findFirst({
      where: {
        id,
        deletedAt: { not: null },
      },
    });

    if (!existing) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Deleted product not found' } },
        { status: 404 }
      );
    }

    // Restore product
    const product = await prisma.product.update({
      where: { id },
      data: {
        deletedAt: null,
        status: 'active',
      },
      include: {
        uom: true,
        aliases: true,
      },
    });

    // Also restore aliases
    await prisma.productAlias.updateMany({
      where: {
        productId: id,
      },
      data: {
        deletedAt: null,
      },
    });

    // Invalidate live index
    invalidateLiveIndex();

    return NextResponse.json(product);

  } catch (error: any) {
    console.error('Error restoring product:', error);

    if (error.code === 'P2025') {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Product not found' } },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to restore product' } },
      { status: 500 }
    );
  }
}
