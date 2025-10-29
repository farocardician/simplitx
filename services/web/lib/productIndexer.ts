/**
 * Product Indexer
 *
 * Manages in-memory indexes for product catalog search and matching.
 * Provides separate indexes for live (active) and staging (draft) products.
 */

import { prisma } from './prisma';
import { normalizeForIndexing } from './productNormalizer';
import type { ProductCandidate } from './productMatcher';

/**
 * Indexed product with searchable fields
 */
interface IndexedProduct {
  id: string;
  description: string;
  hsCode: string | null;
  type: 'BARANG' | 'JASA' | null;
  uomCode: string | null;
  status: string;
  normalized: string;
  tokens: string[];
  nGrams: string[];
}

/**
 * Product index for fast in-memory search
 */
class ProductIndex {
  private products: Map<string, IndexedProduct> = new Map();
  private productIdToEntryKeys: Map<string, Set<string>> = new Map(); // product ID -> entry keys
  private tokenIndex: Map<string, Set<string>> = new Map(); // token -> entry keys
  private ngramIndex: Map<string, Set<string>> = new Map(); // ngram -> entry keys
  private lastRefresh: Date | null = null;
  private entryCounter: number = 0;

  /**
   * Adds a product to the index
   */
  add(product: IndexedProduct): void {
    // Generate unique entry key for this product/alias
    const entryKey = `${product.id}:${this.entryCounter++}`;
    this.products.set(entryKey, product);

    // Track which entry keys belong to this product ID
    if (!this.productIdToEntryKeys.has(product.id)) {
      this.productIdToEntryKeys.set(product.id, new Set());
    }
    this.productIdToEntryKeys.get(product.id)!.add(entryKey);

    // Index tokens
    for (const token of product.tokens) {
      if (!this.tokenIndex.has(token)) {
        this.tokenIndex.set(token, new Set());
      }
      this.tokenIndex.get(token)!.add(entryKey);
    }

    // Index n-grams
    for (const ngram of product.nGrams) {
      if (!this.ngramIndex.has(ngram)) {
        this.ngramIndex.set(ngram, new Set());
      }
      this.ngramIndex.get(ngram)!.add(entryKey);
    }
  }

  /**
   * Removes a product from the index
   */
  remove(productId: string): void {
    const entryKeys = this.productIdToEntryKeys.get(productId);
    if (!entryKeys) return;

    for (const entryKey of entryKeys) {
      const product = this.products.get(entryKey);
      if (!product) continue;

      // Remove from token index
      for (const token of product.tokens) {
        const keys = this.tokenIndex.get(token);
        if (keys) {
          keys.delete(entryKey);
          if (keys.size === 0) {
            this.tokenIndex.delete(token);
          }
        }
      }

      // Remove from n-gram index
      for (const ngram of product.nGrams) {
        const keys = this.ngramIndex.get(ngram);
        if (keys) {
          keys.delete(entryKey);
          if (keys.size === 0) {
            this.ngramIndex.delete(ngram);
          }
        }
      }

      this.products.delete(entryKey);
    }

    this.productIdToEntryKeys.delete(productId);
  }

  /**
   * Searches for products matching query tokens
   * Returns entry keys ranked by token overlap
   */
  search(queryTokens: string[], queryNGrams: string[]): string[] {
    const candidateScores: Map<string, number> = new Map();

    // Score by token matches
    for (const token of queryTokens) {
      const matchingKeys = this.tokenIndex.get(token);
      if (matchingKeys) {
        for (const key of matchingKeys) {
          candidateScores.set(key, (candidateScores.get(key) || 0) + 1);
        }
      }
    }

    // Boost score by n-gram matches
    for (const ngram of queryNGrams) {
      const matchingKeys = this.ngramIndex.get(ngram);
      if (matchingKeys) {
        for (const key of matchingKeys) {
          candidateScores.set(key, (candidateScores.get(key) || 0) + 0.5);
        }
      }
    }

    // Sort by score descending
    const ranked = Array.from(candidateScores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => key);

    return ranked;
  }

  /**
   * Gets a product by entry key
   */
  get(entryKey: string): IndexedProduct | undefined {
    return this.products.get(entryKey);
  }

  /**
   * Gets all products
   */
  getAll(): IndexedProduct[] {
    return Array.from(this.products.values());
  }

  /**
   * Clears the entire index
   */
  clear(): void {
    this.products.clear();
    this.productIdToEntryKeys.clear();
    this.tokenIndex.clear();
    this.ngramIndex.clear();
    this.lastRefresh = null;
    this.entryCounter = 0;
  }

  /**
   * Gets the number of products in the index
   */
  size(): number {
    return this.products.size;
  }

  /**
   * Gets the last refresh timestamp
   */
  getLastRefresh(): Date | null {
    return this.lastRefresh;
  }

  /**
   * Sets the last refresh timestamp
   */
  setLastRefresh(date: Date): void {
    this.lastRefresh = date;
  }
}

// Global indexes
let liveIndex: ProductIndex | null = null;
let stagingIndex: ProductIndex | null = null;

/**
 * Gets or creates the live product index (active products only)
 */
export function getLiveIndex(): ProductIndex {
  if (!liveIndex) {
    liveIndex = new ProductIndex();
  }
  return liveIndex;
}

/**
 * Gets or creates the staging product index (draft products)
 */
export function getStagingIndex(): ProductIndex {
  if (!stagingIndex) {
    stagingIndex = new ProductIndex();
  }
  return stagingIndex;
}

/**
 * Refreshes the live index from the database
 * Loads all active products and their active aliases
 */
export async function refreshLiveIndex(): Promise<void> {
  const index = getLiveIndex();
  index.clear();

  // Load active products
  const products = await prisma.product.findMany({
    where: {
      status: 'active',
      deletedAt: null,
    },
    include: {
      aliases: {
        where: {
          status: 'active',
          deletedAt: null,
        },
      },
    },
  });

  // Index main product descriptions
  for (const product of products) {
    const normalized = normalizeForIndexing(product.description);

    const indexedProduct: IndexedProduct = {
      id: product.id,
      description: product.description,
      hsCode: product.hsCode,
      type: product.type,
      uomCode: product.uomCode,
      status: product.status,
      normalized: normalized.normalized,
      tokens: normalized.tokensWithoutStopWords,
      nGrams: normalized.allNGrams,
    };

    index.add(indexedProduct);

    // Also index aliases as separate searchable entries
    // but pointing to the same product ID
    for (const alias of product.aliases) {
      const aliasNormalized = normalizeForIndexing(alias.aliasDescription);

      const indexedAlias: IndexedProduct = {
        id: product.id, // Same product ID
        description: alias.aliasDescription,
        hsCode: product.hsCode,
        type: product.type,
        uomCode: product.uomCode,
        status: product.status,
        normalized: aliasNormalized.normalized,
        tokens: aliasNormalized.tokensWithoutStopWords,
        nGrams: aliasNormalized.allNGrams,
      };

      index.add(indexedAlias);
    }
  }

  index.setLastRefresh(new Date());
}

/**
 * Refreshes the staging index from the database
 * Loads all draft products pending approval
 */
export async function refreshStagingIndex(): Promise<void> {
  const index = getStagingIndex();
  index.clear();

  const drafts = await prisma.productDraft.findMany({
    where: {
      status: 'draft',
      kind: 'new_product',
    },
  });

  for (const draft of drafts) {
    if (!draft.description) continue;

    const normalized = normalizeForIndexing(draft.description);

    const indexedDraft: IndexedProduct = {
      id: draft.id,
      description: draft.description,
      hsCode: draft.hsCode,
      type: draft.type,
      uomCode: draft.uomCode,
      status: 'draft',
      normalized: normalized.normalized,
      tokens: normalized.tokensWithoutStopWords,
      nGrams: normalized.allNGrams,
    };

    index.add(indexedDraft);
  }

  index.setLastRefresh(new Date());
}

/**
 * Searches the live index for matching products
 *
 * @param query - Search query description
 * @param limit - Maximum number of results (default: 10)
 * @returns Array of product candidates ranked by relevance
 */
export async function searchLiveProducts(
  query: string,
  limit: number = 10
): Promise<ProductCandidate[]> {
  const index = getLiveIndex();

  // Refresh index if empty
  if (index.size() === 0) {
    await refreshLiveIndex();
  }

  const normalized = normalizeForIndexing(query);
  const productIds = index.search(normalized.tokensWithoutStopWords, normalized.allNGrams);

  const candidates: ProductCandidate[] = [];

  for (const id of productIds.slice(0, limit)) {
    const product = index.get(id);
    if (product) {
      candidates.push({
        id: product.id,
        description: product.description,
        hsCode: product.hsCode,
        type: product.type,
        uomCode: product.uomCode,
        status: product.status,
      });
    }
  }

  return candidates;
}

/**
 * Invalidates and clears the live index
 * Next search will trigger a refresh
 */
export function invalidateLiveIndex(): void {
  const index = getLiveIndex();
  index.clear();
}

/**
 * Invalidates and clears the staging index
 */
export function invalidateStagingIndex(): void {
  const index = getStagingIndex();
  index.clear();
}

/**
 * Gets index statistics
 */
export function getIndexStats(): {
  live: { size: number; lastRefresh: Date | null };
  staging: { size: number; lastRefresh: Date | null };
} {
  return {
    live: {
      size: getLiveIndex().size(),
      lastRefresh: getLiveIndex().getLastRefresh(),
    },
    staging: {
      size: getStagingIndex().size(),
      lastRefresh: getStagingIndex().getLastRefresh(),
    },
  };
}
