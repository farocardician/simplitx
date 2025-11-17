import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { invalidateLiveIndex } from '@/lib/productIndexer';

type RouteContext = {
  params: {
    id: string;
    aliasId: string;
  };
};

/**
 * PUT /api/products/:id/aliases/:aliasId
 *
 * Update an alias
 */
export async function PUT(req: NextRequest, context: RouteContext) {
  try {
    const { id, aliasId } = context.params;
    const { aliasDescription, updatedBy } = await req.json();

    // Validation
    if (!aliasDescription || typeof aliasDescription !== 'string' || aliasDescription.trim().length === 0) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'aliasDescription is required' } },
        { status: 400 }
      );
    }

    // Check if alias exists
    const existingAlias = await prisma.productAlias.findUnique({
      where: { id: aliasId, deletedAt: null },
      include: { product: true },
    });

    if (!existingAlias || existingAlias.productId !== id) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Alias not found' } },
        { status: 404 }
      );
    }

    // Check for duplicate alias (case-insensitive, excluding current alias)
    const duplicate = await prisma.productAlias.findFirst({
      where: {
        id: { not: aliasId },
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
    if (existingAlias.product.description.toLowerCase() === aliasDescription.trim().toLowerCase()) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Alias cannot be the same as product description' } },
        { status: 400 }
      );
    }

    // Update alias
    const alias = await prisma.productAlias.update({
      where: { id: aliasId },
      data: {
        aliasDescription: aliasDescription.trim(),
        updatedBy: updatedBy || 'admin',
      },
    });

    // Invalidate live index
    invalidateLiveIndex();

    return NextResponse.json(alias);
  } catch (error) {
    console.error('Error updating alias:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to update alias' } },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/products/:id/aliases/:aliasId
 *
 * Delete an alias (soft delete)
 */
export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const { id, aliasId } = context.params;

    // Check if alias exists
    const existingAlias = await prisma.productAlias.findUnique({
      where: { id: aliasId, deletedAt: null },
    });

    if (!existingAlias || existingAlias.productId !== id) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Alias not found' } },
        { status: 404 }
      );
    }

    // Soft delete
    await prisma.productAlias.update({
      where: { id: aliasId },
      data: {
        deletedAt: new Date(),
        status: 'draft', // Mark as draft when deleted
      },
    });

    // Invalidate live index
    invalidateLiveIndex();

    return NextResponse.json({ success: true, message: 'Alias deleted' });
  } catch (error) {
    console.error('Error deleting alias:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to delete alias' } },
      { status: 500 }
    );
  }
}
