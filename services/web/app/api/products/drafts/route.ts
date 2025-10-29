import { NextRequest, NextResponse } from 'next/server';
import { createDraftFromManualEntry, createAliasDraft } from '@/lib/productEnrichment';
import type { HsCodeType } from '@prisma/client';

/**
 * POST /api/products/drafts
 *
 * Creates a draft product from manual entry
 * Used when user manually enters HS Code, Type, or UOM that wasn't auto-filled
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      kind,
      description,
      hsCode,
      type,
      uomCode,
      productId,
      aliasDescription,
      sourceInvoiceId,
      sourcePdfLineText,
      enrichmentEventId,
      confidenceScore,
      createdBy,
    } = body;

    // Validate kind
    if (!kind || !['new_product', 'alias'].includes(kind)) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'kind must be "new_product" or "alias"' } },
        { status: 400 }
      );
    }

    if (kind === 'new_product') {
      // Validate new product draft
      if (!description || typeof description !== 'string' || description.trim().length === 0) {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'description is required for new_product draft' } },
          { status: 400 }
        );
      }

      // At least one field should be provided
      if (!hsCode && !type && !uomCode) {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'at least one of hsCode, type, or uomCode is required' } },
          { status: 400 }
        );
      }

      // Validate type enum
      if (type && !['BARANG', 'JASA'].includes(type)) {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'type must be "BARANG" or "JASA"' } },
          { status: 400 }
        );
      }

      const draft = await createDraftFromManualEntry({
        description: description.trim(),
        hsCode,
        type: type as HsCodeType,
        uomCode,
        sourceInvoiceId,
        sourcePdfLineText,
        enrichmentEventId,
        createdBy,
      });

      return NextResponse.json(draft, { status: 201 });

    } else {
      // Alias draft
      if (!productId || typeof productId !== 'string') {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'productId is required for alias draft' } },
          { status: 400 }
        );
      }

      if (!aliasDescription || typeof aliasDescription !== 'string' || aliasDescription.trim().length === 0) {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'aliasDescription is required for alias draft' } },
          { status: 400 }
        );
      }

      const draft = await createAliasDraft({
        productId,
        aliasDescription: aliasDescription.trim(),
        sourceInvoiceId,
        sourcePdfLineText,
        confidenceScore,
        createdBy,
      });

      return NextResponse.json(draft, { status: 201 });
    }

  } catch (error: any) {
    console.error('Error creating product draft:', error);

    // Handle Prisma errors
    if (error.code === 'P2003') {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Referenced product not found' } },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to create product draft' } },
      { status: 500 }
    );
  }
}

/**
 * GET /api/products/drafts
 *
 * Lists product drafts with filtering and pagination
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    const status = searchParams.get('status');
    const kind = searchParams.get('kind');
    const page = parseInt(searchParams.get('page') || '1', 10);
    const pageSize = parseInt(searchParams.get('pageSize') || '20', 10);

    if (page < 1 || pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'invalid pagination parameters' } },
        { status: 400 }
      );
    }

    const where: any = {};

    if (status && ['draft', 'approved', 'rejected'].includes(status)) {
      where.status = status;
    }

    if (kind && ['new_product', 'alias'].includes(kind)) {
      where.kind = kind;
    }

    const [drafts, total] = await Promise.all([
      (await import('@/lib/prisma')).prisma.productDraft.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      (await import('@/lib/prisma')).prisma.productDraft.count({ where }),
    ]);

    return NextResponse.json({
      drafts,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });

  } catch (error) {
    console.error('Error listing product drafts:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to list product drafts' } },
      { status: 500 }
    );
  }
}
