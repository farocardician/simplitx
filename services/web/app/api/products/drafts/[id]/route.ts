import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { HsCodeType, ProductDraftKind } from '@prisma/client';

type RouteContext = {
  params: {
    id: string;
  };
};

/**
 * GET /api/products/drafts/:id
 *
 * Gets a single draft by ID with details
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const { id } = context.params;

    const draft = await prisma.productDraft.findUnique({
      where: { id },
    });

    if (!draft) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Draft not found' } },
        { status: 404 }
      );
    }

    // Get enrichment event if linked
    let enrichmentEvent = null;
    if (draft.sourceInvoiceId) {
      enrichmentEvent = await prisma.enrichmentEvent.findFirst({
        where: {
          draftId: id,
        },
      });
    }

    // Get target product if alias
    let targetProduct = null;
    if (draft.kind === 'alias' && draft.targetProductId) {
      targetProduct = await prisma.product.findUnique({
        where: { id: draft.targetProductId },
        include: {
          uom: true,
        },
      });
    }

    return NextResponse.json({
      draft,
      enrichmentEvent,
      targetProduct,
    });

  } catch (error) {
    console.error('Error getting draft:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to get draft' } },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/products/drafts/:id
 *
 * Updates a draft in-place while it is under review
 */
export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const { id } = context.params;
    const draft = await prisma.productDraft.findUnique({ where: { id } });

    if (!draft) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Draft not found' } },
        { status: 404 }
      );
    }

    if (draft.status !== 'draft') {
      return NextResponse.json(
        { error: { code: 'INVALID_STATE', message: 'Only drafts in draft status can be updated' } },
        { status: 400 }
      );
    }

    const body = await req.json();

    const updates: Record<string, unknown> = {};

    if ('kind' in body) {
      const { kind } = body as { kind: ProductDraftKind };
      if (kind !== 'new_product' && kind !== 'alias') {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'kind must be "new_product" or "alias"' } },
          { status: 400 }
        );
      }
      updates.kind = kind;
    }

    if ('description' in body) {
      const { description } = body as { description: unknown };
      if (description !== null && typeof description !== 'string') {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'description must be a string or null' } },
          { status: 400 }
        );
      }
      updates.description = description === null ? null : (description as string).trim();
    }

    if ('aliasDescription' in body) {
      const { aliasDescription } = body as { aliasDescription: unknown };
      if (aliasDescription !== null && typeof aliasDescription !== 'string') {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'aliasDescription must be a string or null' } },
          { status: 400 }
        );
      }
      updates.aliasDescription = aliasDescription === null ? null : (aliasDescription as string).trim();
    }

    if ('hsCode' in body) {
      const { hsCode } = body as { hsCode: unknown };
      if (hsCode !== null && typeof hsCode !== 'string') {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'hsCode must be a string or null' } },
          { status: 400 }
        );
      }
      if (typeof hsCode === 'string' && hsCode.trim() !== '') {
        const cleaned = hsCode.replace(/[^0-9]/g, '');
        if (cleaned.length === 0) {
          return NextResponse.json(
            { error: { code: 'INVALID_REQUEST', message: 'hsCode must contain digits' } },
            { status: 400 }
          );
        }
        updates.hsCode = cleaned.padEnd(6, '0').slice(0, 6);
      } else {
        updates.hsCode = null;
      }
    }

    if ('type' in body) {
      const { type } = body as { type: unknown };
      if (type !== null && typeof type !== 'string') {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'type must be a string or null' } },
          { status: 400 }
        );
      }

      if (typeof type === 'string' && type.trim() !== '') {
        const upper = type.trim().toUpperCase();
        if (upper !== 'BARANG' && upper !== 'JASA') {
          return NextResponse.json(
            { error: { code: 'INVALID_REQUEST', message: 'type must be BARANG or JASA' } },
            { status: 400 }
          );
        }
        updates.type = upper as HsCodeType;
      } else {
        updates.type = null;
      }
    }

    if ('uomCode' in body) {
      const { uomCode } = body as { uomCode: unknown };
      if (uomCode !== null && typeof uomCode !== 'string') {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'uomCode must be a string or null' } },
          { status: 400 }
        );
      }
      updates.uomCode = typeof uomCode === 'string' && uomCode.trim() !== '' ? uomCode.trim() : null;
    }

    if ('targetProductId' in body) {
      const { targetProductId } = body as { targetProductId: unknown };
      if (targetProductId !== null && typeof targetProductId !== 'string') {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'targetProductId must be a string or null' } },
          { status: 400 }
        );
      }
      updates.targetProductId = targetProductId ?? null;
    }

    if ('confidenceScore' in body) {
      const { confidenceScore } = body as { confidenceScore: unknown };
      if (confidenceScore !== null && typeof confidenceScore !== 'number') {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'confidenceScore must be a number or null' } },
          { status: 400 }
        );
      }
      updates.confidenceScore = confidenceScore as number | null;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ draft });
    }

    const updated = await prisma.productDraft.update({
      where: { id },
      data: updates,
    });

    return NextResponse.json({ draft: updated });

  } catch (error) {
    console.error('Error updating draft:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to update draft' } },
      { status: 500 }
    );
  }
}
