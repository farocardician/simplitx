/**
 * Product Catalog Types
 *
 * Type definitions for the product catalog feature including products,
 * aliases, drafts, and enrichment events.
 */

import type { HsCodeType } from '@prisma/client';

/**
 * Product status
 */
export type ProductStatus = 'active' | 'inactive';

/**
 * Product alias status
 */
export type ProductAliasStatus = 'active' | 'draft';

/**
 * Product draft kind
 */
export type ProductDraftKind = 'new_product' | 'alias';

/**
 * Product draft status
 */
export type ProductDraftStatus = 'draft' | 'approved' | 'rejected';

/**
 * Product (active catalog entry)
 */
export interface Product {
  id: string;
  description: string;
  hsCode: string | null;
  type: HsCodeType | null;
  uomCode: string | null;
  status: ProductStatus;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
}

/**
 * Product with relations
 */
export interface ProductWithRelations extends Product {
  uom?: {
    code: string;
    name: string;
  } | null;
  aliases: ProductAlias[];
}

/**
 * Product alias (alternative description for a product)
 */
export interface ProductAlias {
  id: string;
  productId: string;
  aliasDescription: string;
  status: ProductAliasStatus;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
}

/**
 * Product draft (pending approval)
 */
export interface ProductDraft {
  id: string;
  kind: ProductDraftKind;

  // Proposed fields
  description: string | null;
  hsCode: string | null;
  type: HsCodeType | null;
  uomCode: string | null;

  // For alias kind
  targetProductId: string | null;
  aliasDescription: string | null;

  // Source context
  sourceInvoiceId: string | null;
  sourcePdfLineText: string | null;

  // Scoring and status
  confidenceScore: number | null;
  status: ProductDraftStatus;

  // Review metadata
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;

  // Audit
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}

/**
 * Enrichment event (log of auto-fill attempts)
 */
export interface EnrichmentEvent {
  id: string;
  invoiceId: string | null;
  lineItemIndex: number | null;
  inputDescription: string;
  matchedProductId: string | null;
  matchScore: number | null;
  threshold: number;
  autoFilled: boolean;
  enrichedHsCode: string | null;
  enrichedType: HsCodeType | null;
  enrichedUomCode: string | null;
  draftCreated: boolean;
  draftId: string | null;
  createdAt: Date;
  createdBy: string | null;
}

/**
 * Create product input
 */
export interface CreateProductInput {
  description: string;
  hsCode?: string;
  type?: HsCodeType;
  uomCode?: string;
  status?: ProductStatus;
  createdBy?: string;
}

/**
 * Update product input
 */
export interface UpdateProductInput {
  description?: string;
  hsCode?: string;
  type?: HsCodeType;
  uomCode?: string;
  status?: ProductStatus;
  updatedBy?: string;
}

/**
 * Create product alias input
 */
export interface CreateProductAliasInput {
  productId: string;
  aliasDescription: string;
  status?: ProductAliasStatus;
  createdBy?: string;
}

/**
 * Create product draft input
 */
export interface CreateProductDraftInput {
  kind: ProductDraftKind;
  description?: string;
  hsCode?: string;
  type?: HsCodeType;
  uomCode?: string;
  targetProductId?: string;
  aliasDescription?: string;
  sourceInvoiceId?: string;
  sourcePdfLineText?: string;
  confidenceScore?: number;
  createdBy?: string;
}

/**
 * Review product draft input
 */
export interface ReviewProductDraftInput {
  status: 'approved' | 'rejected';
  reviewNotes?: string;
  reviewedBy: string;

  // For editing before approval
  description?: string;
  hsCode?: string;
  type?: HsCodeType;
  uomCode?: string;
  aliasDescription?: string;
}

/**
 * Enrichment request
 */
export interface EnrichmentRequest {
  description: string;
  invoiceId?: string;
  lineItemIndex?: number;
  threshold?: number; // Default: 0.8
  createdBy?: string;
}

/**
 * Enrichment response
 */
export interface EnrichmentResponse {
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
  draftCreated: boolean;
  draftId: string | null;
  eventId: string;
}

/**
 * Product search result
 */
export interface ProductSearchResult {
  products: Product[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Product draft list result
 */
export interface ProductDraftListResult {
  drafts: ProductDraft[];
  total: number;
  page: number;
  pageSize: number;
}
