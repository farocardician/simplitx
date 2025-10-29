/**
 * Product Enrichment Service
 *
 * Handles automatic enrichment of product descriptions with HS Code, Type, and UOM
 * based on matching against the live product catalog.
 */

import { prisma } from './prisma';
import { searchLiveProducts, refreshLiveIndex } from './productIndexer';
import { findBestMatch } from './productMatcher';
import type { HsCodeType } from '@prisma/client';

/**
 * Enrichment request parameters
 */
export interface EnrichmentRequest {
  description: string;
  invoiceId?: string;
  lineItemIndex?: number;
  threshold?: number; // Default: 0.8
  createdBy?: string;
}

/**
 * Enrichment result
 */
export interface EnrichmentResult {
  matched: boolean;
  autoFilled: boolean;
  matchScore: number | null;
  product: {
    id: string;
    description: string;
    hsCode: string | null;
    type: HsCodeType | null;
    uomCode: string | null;
  } | null;
  enrichedFields: {
    hsCode: string | null;
    type: HsCodeType | null;
    uomCode: string | null;
  } | null;
  eventId: string;
}

/**
 * Enriches a product description by matching against the live catalog
 *
 * Behavior:
 * - Score >= threshold (default 0.80): Auto-fill HS Code, Type, UOM
 * - Score < threshold: No enrichment, returns match info only
 * - Always logs an enrichment event
 *
 * @param request - Enrichment request parameters
 * @returns Enrichment result with matched product and auto-fill decision
 */
export async function enrichProductDescription(
  request: EnrichmentRequest
): Promise<EnrichmentResult> {
  const threshold = request.threshold ?? 0.8;

  // Search live catalog for matching products
  const candidates = await searchLiveProducts(request.description, 10);

  // Find best match using matcher algorithm
  const bestMatch = findBestMatch(request.description, candidates, 0.0); // Get best match regardless of threshold for logging

  const matched = bestMatch !== null;
  const autoFilled = matched && bestMatch.matchScore >= threshold;

  // Prepare enriched fields (only if auto-fill threshold met)
  const enrichedFields = autoFilled && bestMatch
    ? {
        hsCode: bestMatch.hsCode ?? null,
        type: bestMatch.type ?? null,
        uomCode: bestMatch.uomCode ?? null,
      }
    : null;

  // Fetch canonical product data from database (not from index which might contain alias)
  let canonicalProduct: any = null;
  if (bestMatch) {
    canonicalProduct = await prisma.product.findUnique({
      where: { id: bestMatch.id },
      select: {
        id: true,
        description: true,
        hsCode: true,
        type: true,
        uomCode: true,
      },
    });
  }

  // Log enrichment event
  const event = await prisma.enrichmentEvent.create({
    data: {
      invoiceId: request.invoiceId ?? null,
      lineItemIndex: request.lineItemIndex ?? null,
      inputDescription: request.description,
      matchedProductId: bestMatch?.id ?? null,
      matchScore: bestMatch?.matchScore ?? null,
      threshold,
      autoFilled,
      enrichedHsCode: enrichedFields?.hsCode ?? null,
      enrichedType: enrichedFields?.type ?? null,
      enrichedUomCode: enrichedFields?.uomCode ?? null,
      draftCreated: false, // Will be updated when draft is created
      draftId: null,
      createdBy: request.createdBy ?? null,
    },
  });

  return {
    matched,
    autoFilled,
    matchScore: bestMatch?.matchScore ?? null,
    product: canonicalProduct
      ? {
          id: canonicalProduct.id,
          description: canonicalProduct.description,
          hsCode: canonicalProduct.hsCode ?? null,
          type: canonicalProduct.type ?? null,
          uomCode: canonicalProduct.uomCode ?? null,
        }
      : null,
    enrichedFields,
    eventId: event.id,
  };
}

/**
 * Creates a draft product from manual entry
 *
 * When a user manually enters HS Code, Type, and/or UOM for a product description
 * that wasn't auto-filled, we create a draft product for review.
 *
 * @param params - Draft creation parameters
 * @returns Created draft product
 */
export interface CreateDraftFromManualEntryParams {
  description: string;
  hsCode?: string;
  type?: HsCodeType;
  uomCode?: string;
  sourceInvoiceId?: string;
  sourcePdfLineText?: string;
  enrichmentEventId?: string;
  createdBy?: string;
}

export async function createDraftFromManualEntry(
  params: CreateDraftFromManualEntryParams
) {
  // Create draft product
  const draft = await prisma.productDraft.create({
    data: {
      kind: 'new_product',
      description: params.description,
      hsCode: params.hsCode ?? null,
      type: params.type ?? null,
      uomCode: params.uomCode ?? null,
      sourceInvoiceId: params.sourceInvoiceId ?? null,
      sourcePdfLineText: params.sourcePdfLineText ?? null,
      confidenceScore: null, // Manual entry, no confidence score
      status: 'draft',
      createdBy: params.createdBy ?? null,
    },
  });

  // Update enrichment event to link to draft
  if (params.enrichmentEventId) {
    await prisma.enrichmentEvent.update({
      where: { id: params.enrichmentEventId },
      data: {
        draftCreated: true,
        draftId: draft.id,
      },
    });
  }

  return draft;
}

/**
 * Creates a draft alias for an existing product
 *
 * When a user corrects an auto-filled product (changes the matched product),
 * we can create an alias draft linking the description to the correct product.
 *
 * @param params - Alias draft creation parameters
 * @returns Created alias draft
 */
export interface CreateAliasDraftParams {
  productId: string;
  aliasDescription: string;
  sourceInvoiceId?: string;
  sourcePdfLineText?: string;
  confidenceScore?: number;
  createdBy?: string;
}

export async function createAliasDraft(params: CreateAliasDraftParams) {
  const draft = await prisma.productDraft.create({
    data: {
      kind: 'alias',
      targetProductId: params.productId,
      aliasDescription: params.aliasDescription,
      sourceInvoiceId: params.sourceInvoiceId ?? null,
      sourcePdfLineText: params.sourcePdfLineText ?? null,
      confidenceScore: params.confidenceScore ?? null,
      status: 'draft',
      createdBy: params.createdBy ?? null,
    },
  });

  return draft;
}

/**
 * Batch enrichment for multiple descriptions
 *
 * Useful for enriching all line items in an invoice at once.
 *
 * @param requests - Array of enrichment requests
 * @returns Array of enrichment results
 */
export async function enrichBatch(
  requests: EnrichmentRequest[]
): Promise<EnrichmentResult[]> {
  // Ensure index is populated
  await refreshLiveIndex();

  const results: EnrichmentResult[] = [];

  for (const request of requests) {
    const result = await enrichProductDescription(request);
    results.push(result);
  }

  return results;
}

/**
 * Gets enrichment statistics for reporting
 */
export async function getEnrichmentStats(
  filters?: {
    invoiceId?: string;
    startDate?: Date;
    endDate?: Date;
  }
) {
  const where: any = {};

  if (filters?.invoiceId) {
    where.invoiceId = filters.invoiceId;
  }

  if (filters?.startDate || filters?.endDate) {
    where.createdAt = {};
    if (filters.startDate) {
      where.createdAt.gte = filters.startDate;
    }
    if (filters.endDate) {
      where.createdAt.lte = filters.endDate;
    }
  }

  const [total, autoFilled, draftsCreated] = await Promise.all([
    prisma.enrichmentEvent.count({ where }),
    prisma.enrichmentEvent.count({ where: { ...where, autoFilled: true } }),
    prisma.enrichmentEvent.count({ where: { ...where, draftCreated: true } }),
  ]);

  const avgScore = await prisma.enrichmentEvent.aggregate({
    where: {
      ...where,
      matchScore: { not: null },
    },
    _avg: {
      matchScore: true,
    },
  });

  return {
    total,
    autoFilled,
    autoFillRate: total > 0 ? autoFilled / total : 0,
    draftsCreated,
    averageMatchScore: avgScore._avg.matchScore ?? 0,
  };
}
