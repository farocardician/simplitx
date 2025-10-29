import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

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
