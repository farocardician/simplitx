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
 * POST /api/products/drafts/:id/review
 *
 * Reviews a draft product (approve or reject)
 * On approve: creates active product or alias, updates draft status, refreshes live index
 * On reject: updates draft status to rejected with notes
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const { id } = context.params;
    const body = await req.json();
    const { action, reviewedBy, reviewNotes, updates } = body;

    // Validation
    if (!action || !['approve', 'reject'].includes(action)) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'action must be "approve" or "reject"' } },
        { status: 400 }
      );
    }

    if (!reviewedBy) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'reviewedBy is required' } },
        { status: 400 }
      );
    }

    // Get draft
    const draft = await prisma.productDraft.findUnique({
      where: { id },
    });

    if (!draft) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Draft not found' } },
        { status: 404 }
      );
    }

    if (draft.status !== 'draft') {
      return NextResponse.json(
        { error: { code: 'INVALID_STATE', message: `Draft has already been ${draft.status}` } },
        { status: 400 }
      );
    }

    if (action === 'reject') {
      // Reject draft
      const updated = await prisma.productDraft.update({
        where: { id },
        data: {
          status: 'rejected',
          reviewedBy,
          reviewedAt: new Date(),
          reviewNotes: reviewNotes || null,
        },
      });

      return NextResponse.json({
        success: true,
        message: 'Draft rejected',
        draft: updated,
      });
    }

    // Approve draft
    if (action === 'approve') {
      // Apply updates if provided (edit before approve)
      let finalDraft = draft;
      if (updates) {
        finalDraft = await prisma.productDraft.update({
          where: { id },
          data: {
            description: updates.description !== undefined ? updates.description : draft.description,
            hsCode: updates.hsCode !== undefined ? updates.hsCode : draft.hsCode,
            type: updates.type !== undefined ? updates.type : draft.type,
            uomCode: updates.uomCode !== undefined ? updates.uomCode : draft.uomCode,
            aliasDescription: updates.aliasDescription !== undefined ? updates.aliasDescription : draft.aliasDescription,
          },
        });
      }

      let result: any;

      if (finalDraft.kind === 'new_product') {
        // Create new active product
        if (!finalDraft.description) {
          return NextResponse.json(
            { error: { code: 'INVALID_REQUEST', message: 'Description is required for new product' } },
            { status: 400 }
          );
        }

        // Verify UOM exists if provided
        if (finalDraft.uomCode) {
          const uomExists = await prisma.unitOfMeasure.findUnique({
            where: { code: finalDraft.uomCode },
          });

          if (!uomExists) {
            return NextResponse.json(
              { error: { code: 'NOT_FOUND', message: 'UOM code not found' } },
              { status: 404 }
            );
          }
        }

        // Check for duplicate description
        const existing = await prisma.product.findFirst({
          where: {
            description: {
              equals: finalDraft.description,
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

        const product = await prisma.product.create({
          data: {
            description: finalDraft.description,
            hsCode: finalDraft.hsCode,
            type: finalDraft.type as HsCodeType,
            uomCode: finalDraft.uomCode,
            status: 'active',
            createdBy: finalDraft.createdBy || reviewedBy,
          },
          include: {
            uom: true,
            aliases: true,
          },
        });

        result = { type: 'product', data: product };

      } else if (finalDraft.kind === 'alias') {
        // Create product alias
        if (!finalDraft.targetProductId || !finalDraft.aliasDescription) {
          return NextResponse.json(
            { error: { code: 'INVALID_REQUEST', message: 'targetProductId and aliasDescription are required for alias' } },
            { status: 400 }
          );
        }

        // Verify target product exists
        const targetProduct = await prisma.product.findFirst({
          where: {
            id: finalDraft.targetProductId,
            deletedAt: null,
          },
        });

        if (!targetProduct) {
          return NextResponse.json(
            { error: { code: 'NOT_FOUND', message: 'Target product not found' } },
            { status: 404 }
          );
        }

        const alias = await prisma.productAlias.create({
          data: {
            productId: finalDraft.targetProductId,
            aliasDescription: finalDraft.aliasDescription,
            status: 'active',
            createdBy: finalDraft.createdBy || reviewedBy,
          },
        });

        result = { type: 'alias', data: alias };
      }

      // Update draft status
      const approvedDraft = await prisma.productDraft.update({
        where: { id },
        data: {
          status: 'approved',
          reviewedBy,
          reviewedAt: new Date(),
          reviewNotes: reviewNotes || null,
        },
      });

      // Invalidate live index (will refresh on next search)
      invalidateLiveIndex();

      return NextResponse.json({
        success: true,
        message: 'Draft approved and product created',
        draft: approvedDraft,
        created: result,
      });
    }

  } catch (error: any) {
    console.error('Error reviewing draft:', error);

    if (error.code === 'P2003') {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Referenced product or UOM not found' } },
        { status: 404 }
      );
    }

    if (error.code === 'P2025') {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Draft not found' } },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to review draft' } },
      { status: 500 }
    );
  }
}
