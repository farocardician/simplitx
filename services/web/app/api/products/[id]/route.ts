import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { invalidateLiveIndex } from '@/lib/productIndexer';
import type { HsCodeType } from '@prisma/client';

type RouteContext = {
  params: {
    id: string;
  };
};

/**
 * GET /api/products/:id
 *
 * Gets a single product by ID
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const { id } = context.params;

    const product = await prisma.product.findFirst({
      where: {
        id,
        deletedAt: null,
      },
      include: {
        uom: true,
        aliases: {
          where: {
            deletedAt: null,
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
    });

    if (!product) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Product not found' } },
        { status: 404 }
      );
    }

    return NextResponse.json(product);

  } catch (error) {
    console.error('Error getting product:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to get product' } },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/products/:id
 *
 * Updates a product
 */
export async function PUT(req: NextRequest, context: RouteContext) {
  try {
    const { id } = context.params;
    const body = await req.json();
    const { description, hsCode, type, uomCode, status, updatedBy } = body;

    // Check product exists
    const existing = await prisma.product.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!existing) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Product not found' } },
        { status: 404 }
      );
    }

    // Validation
    if (description !== undefined) {
      if (typeof description !== 'string' || description.trim().length === 0) {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'description cannot be empty' } },
          { status: 400 }
        );
      }

      if (description.trim().length > 500) {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'description must be 500 characters or less' } },
          { status: 400 }
        );
      }

      // Check for duplicate description (excluding current product)
      const duplicate = await prisma.product.findFirst({
        where: {
          id: { not: id },
          description: {
            equals: description.trim(),
            mode: 'insensitive',
          },
          deletedAt: null,
        },
      });

      if (duplicate) {
        return NextResponse.json(
          { error: { code: 'DUPLICATE', message: 'Another product with this description already exists' } },
          { status: 409 }
        );
      }
    }

    if (hsCode !== undefined && hsCode !== null) {
      if (typeof hsCode !== 'string' || !/^\d{6}$/.test(hsCode)) {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'hsCode must be a 6-digit number' } },
          { status: 400 }
        );
      }
    }

    if (type !== undefined && type !== null && !['BARANG', 'JASA'].includes(type)) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'type must be BARANG or JASA' } },
        { status: 400 }
      );
    }

    if (status !== undefined && !['active', 'inactive'].includes(status)) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'status must be active or inactive' } },
        { status: 400 }
      );
    }

    // Verify UOM exists if provided
    if (uomCode !== undefined && uomCode !== null) {
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

    // Build update data
    const updateData: any = {
      updatedBy: updatedBy || null,
    };

    if (description !== undefined) updateData.description = description.trim();
    if (hsCode !== undefined) updateData.hsCode = hsCode;
    if (type !== undefined) updateData.type = type as HsCodeType;
    if (uomCode !== undefined) updateData.uomCode = uomCode;
    if (status !== undefined) updateData.status = status;

    // Update product
    const product = await prisma.product.update({
      where: { id },
      data: updateData,
      include: {
        uom: true,
        aliases: {
          where: {
            deletedAt: null,
          },
        },
      },
    });

    // Invalidate live index
    invalidateLiveIndex();

    return NextResponse.json(product);

  } catch (error: any) {
    console.error('Error updating product:', error);

    if (error.code === 'P2025') {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Product not found' } },
        { status: 404 }
      );
    }

    if (error.code === 'P2003') {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Referenced UOM not found' } },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to update product' } },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/products/:id
 *
 * Soft deletes a product
 */
export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const { id } = context.params;

    // Check product exists
    const existing = await prisma.product.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!existing) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Product not found' } },
        { status: 404 }
      );
    }

    // Soft delete product (and cascade to aliases)
    await prisma.product.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: 'inactive',
      },
    });

    // Also soft delete aliases
    await prisma.productAlias.updateMany({
      where: {
        productId: id,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    // Invalidate live index
    invalidateLiveIndex();

    return NextResponse.json({ success: true, message: 'Product deleted successfully' });

  } catch (error: any) {
    console.error('Error deleting product:', error);

    if (error.code === 'P2025') {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Product not found' } },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to delete product' } },
      { status: 500 }
    );
  }
}
