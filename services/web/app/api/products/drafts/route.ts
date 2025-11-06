import { NextRequest, NextResponse } from 'next/server';
import { createDraftFromManualEntry, createAliasDraft } from '@/lib/productEnrichment';
import { prisma } from '@/lib/prisma';
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
      prisma.productDraft.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.productDraft.count({ where }),
    ]);

    let draftsWithMeta = drafts;

    if (drafts.length > 0) {
      const draftIds = drafts.map(draft => draft.id);

      const events = await prisma.enrichmentEvent.findMany({
        where: { draftId: { in: draftIds } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          draftId: true,
          matchScore: true,
          matchedProductId: true,
          autoFilled: true,
          inputDescription: true,
          createdAt: true,
        },
      });

      const latestEventByDraft = new Map<string, typeof events[number]>();
      for (const event of events) {
        if (!latestEventByDraft.has(event.draftId)) {
          latestEventByDraft.set(event.draftId, event);
        }
      }

      const matchedProductIds = Array.from(latestEventByDraft.values())
        .map(event => event.matchedProductId)
        .filter((id): id is string => Boolean(id));

      const targetProductIds = drafts
        .map(draft => draft.targetProductId)
        .filter((id): id is string => Boolean(id));

      const combinedProductIds = Array.from(new Set([...matchedProductIds, ...targetProductIds]));

      const relatedProducts = combinedProductIds.length > 0
        ? await prisma.product.findMany({
            where: {
              id: { in: combinedProductIds },
              deletedAt: null,
            },
            select: {
              id: true,
              description: true,
              hsCode: true,
              type: true,
              uomCode: true,
            },
          })
        : [];

      const productMap = new Map<string, typeof relatedProducts[number]>();
      for (const product of relatedProducts) {
        productMap.set(product.id, product);
      }

      draftsWithMeta = drafts.map(draft => {
        const event = latestEventByDraft.get(draft.id) || null;
        const matched = event?.matchedProductId ? productMap.get(event.matchedProductId) || null : null;
        const assignedTarget = draft.targetProductId ? productMap.get(draft.targetProductId) || null : null;

        return {
          ...draft,
          enrichmentEvent: event,
          targetProduct: assignedTarget,
          suggestedProduct: matched,
        };
      });
    }

    return NextResponse.json({
      drafts: draftsWithMeta,
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
