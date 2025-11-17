import { prisma } from '@/lib/prisma';

// ============================================================================
// NORMALIZATION
// ============================================================================

/**
 * Normalize UOM string using single standard:
 * - Trim whitespace
 * - Convert to uppercase
 * - Collapse multiple spaces to single space
 * - Strip punctuation except dots and hyphens
 */
export function normalizeUom(input: string): string {
  return input
    .trim()                      // Remove leading/trailing whitespace
    .toUpperCase()               // Case-insensitive
    .replace(/\s+/g, ' ')        // Collapse multiple spaces
    .replace(/[^\w\s.\-]/g, '')  // Strip punctuation except dots/hyphens
    .trim();                     // Final trim
}

// ============================================================================
// CACHING
// ============================================================================

let aliasCache: Map<string, { code: string; name: string }> | null = null;
let cacheExpiry: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes fallback

/**
 * Invalidate cache immediately (called after mutations)
 */
export function invalidateUomCache(): void {
  aliasCache = null;
  cacheExpiry = 0;
  console.log('[UOMResolver] Cache invalidated');
}

/**
 * Refresh cache if expired or null
 */
async function refreshCache(): Promise<void> {
  const now = Date.now();
  if (aliasCache && now < cacheExpiry) {
    return; // Cache still valid
  }

  const aliases = await prisma.uomAlias.findMany({
    include: { uom: true }
  });

  aliasCache = new Map(
    aliases.map(a => [a.alias, { code: a.uom.code, name: a.uom.name }])
  );

  cacheExpiry = now + CACHE_TTL;
  console.log(`[UOMResolver] Cache refreshed with ${aliasCache.size} aliases`);
}

// ============================================================================
// TELEMETRY
// ============================================================================

interface ResolutionMetrics {
  totalResolutions: number;
  successCount: number;
  failureCount: number;
  topMisses: Map<string, number>; // UOM → count
}

const metrics: ResolutionMetrics = {
  totalResolutions: 0,
  successCount: 0,
  failureCount: 0,
  topMisses: new Map()
};

function trackResolution(input: string, success: boolean): void {
  metrics.totalResolutions++;

  if (success) {
    metrics.successCount++;
  } else {
    metrics.failureCount++;
    const normalized = normalizeUom(input);
    metrics.topMisses.set(
      normalized,
      (metrics.topMisses.get(normalized) || 0) + 1
    );
    console.warn(`[UOMResolver] Unrecognized UOM: "${input}" (normalized: "${normalized}")`);
  }

  // Alert on high failure rate
  const failureRate = metrics.failureCount / metrics.totalResolutions;
  if (failureRate > 0.1 && metrics.totalResolutions > 100) {
    console.error(`[UOMResolver] High failure rate: ${(failureRate * 100).toFixed(1)}%`);
  }
}

export function getResolutionMetrics() {
  const topMissesSorted = Array.from(metrics.topMisses.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  return {
    totalResolutions: metrics.totalResolutions,
    successRate: metrics.totalResolutions > 0
      ? (metrics.successCount / metrics.totalResolutions * 100).toFixed(2) + '%'
      : '0%',
    failureCount: metrics.failureCount,
    topMisses: topMissesSorted.map(([uom, count]) => ({ uom, count }))
  };
}

// ============================================================================
// REQUEST-SCOPED SNAPSHOT
// ============================================================================

export class UomResolverSnapshot {
  private readonly aliasMap: Map<string, { code: string; name: string }>;

  constructor(aliasMap: Map<string, { code: string; name: string }>) {
    // Clone for immutability (request-scoped snapshot)
    this.aliasMap = new Map(aliasMap);
  }

  /**
   * Resolve single UOM alias to canonical code
   */
  resolve(input: string | null | undefined): { code: string; name: string } | null {
    if (!input) return null;

    const normalized = normalizeUom(input);
    const result = this.aliasMap.get(normalized) || null;

    trackResolution(input, !!result);

    return result;
  }

  /**
   * Batch resolve multiple UOM aliases
   */
  resolveMany(inputs: (string | null | undefined)[]): (string | null)[] {
    return inputs.map(input => {
      if (!input) return null;
      const normalized = normalizeUom(input);
      const result = this.aliasMap.get(normalized);

      trackResolution(input, !!result);

      return result?.code || null;
    });
  }

  /**
   * Check if UOM is canonical (exists in unit_of_measures table)
   */
  isCanonical(code: string): boolean {
    const normalized = normalizeUom(code);
    const result = this.aliasMap.get(normalized);
    return result ? result.code === normalized : false;
  }
}

/**
 * Create a request-scoped resolver snapshot
 */
export async function createUomResolverSnapshot(): Promise<UomResolverSnapshot> {
  await refreshCache();
  return new UomResolverSnapshot(aliasCache!);
}

// ============================================================================
// CONVENIENCE FUNCTIONS (for backward compatibility)
// ============================================================================

/**
 * Resolve single UOM alias (creates snapshot internally)
 */
export async function resolveUomAlias(
  input: string | null | undefined
): Promise<{ code: string; name: string } | null> {
  const snapshot = await createUomResolverSnapshot();
  return snapshot.resolve(input);
}

/**
 * Batch resolve UOM aliases (creates snapshot internally)
 */
export async function resolveUomAliases(
  inputs: (string | null | undefined)[]
): Promise<(string | null)[]> {
  const snapshot = await createUomResolverSnapshot();
  return snapshot.resolveMany(inputs);
}

/**
 * Check if UOM code is canonical
 */
export async function isCanonicalUom(code: string): Promise<boolean> {
  const uom = await prisma.unitOfMeasure.findUnique({
    where: { code }
  });
  return !!uom;
}
