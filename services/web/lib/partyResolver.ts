import { prisma } from '@/lib/prisma';

// ============================================================================
// NORMALIZATION (Must match database functions exactly)
// ============================================================================

/**
 * Normalize party name for deterministic lookups.
 * MUST match normalize_party_name() database function exactly.
 */
export function normalizePartyName(displayName: string): string {
  return displayName
    .trim()                        // 1. Trim
    .toUpperCase()                 // 2. Unicode uppercase
    .replace(/[,.\'"]/g, '')       // 3. Strip punctuation: , . ' "
    .replace(/\s+/g, ' ')          // 4. Collapse spaces
    .replace(/[-]+/g, '-')         // 5. Collapse hyphens
    .trim();                       // 6. Final trim
}

/**
 * Normalize TIN for uniqueness checks.
 * MUST match normalize_tin() database function exactly.
 */
export function normalizeTin(tinDisplay: string): string {
  return tinDisplay
    .trim()                        // 1. Trim
    .toUpperCase()                 // 2. Uppercase (for alphanumeric TINs)
    .replace(/[\s.\-/]/g, '');     // 3. Strip: spaces, dots, dashes, slashes
}

// ============================================================================
// PARTY RESOLUTION
// ============================================================================

/**
 * Resolve party name to TIN (for parsed invoices)
 */
export async function resolvePartyByName(
  displayName: string
): Promise<{ tin: string; tinDisplay: string; countryCode: string | null } | null> {
  const normalized = normalizePartyName(displayName);

  const party = await prisma.party.findFirst({
    where: {
      nameNormalized: normalized,
      deletedAt: null
    },
    select: {
      tinNormalized: true,
      tinDisplay: true,
      countryCode: true
    }
  });

  if (!party) return null;

  return {
    tin: party.tinNormalized,
    tinDisplay: party.tinDisplay,
    countryCode: party.countryCode
  };
}

/**
 * Resolve party by TIN (reverse lookup)
 */
export async function resolvePartyByTin(
  tinDisplay: string,
  countryCode?: string | null
): Promise<{
  id: string;
  displayName: string;
  nameNormalized: string;
  tinDisplay: string;
  countryCode: string | null;
} | null> {
  const normalized = normalizeTin(tinDisplay);

  const where: any = {
    tinNormalized: normalized,
    deletedAt: null
  };

  if (countryCode !== undefined) {
    where.countryCode = countryCode;
  }

  const party = await prisma.party.findFirst({
    where,
    select: {
      id: true,
      displayName: true,
      nameNormalized: true,
      tinDisplay: true,
      countryCode: true
    }
  });

  return party;
}

/**
 * Check if party name is already registered
 */
export async function isPartyNameRegistered(displayName: string): Promise<boolean> {
  const normalized = normalizePartyName(displayName);

  const count = await prisma.party.count({
    where: {
      nameNormalized: normalized,
      deletedAt: null
    }
  });

  return count > 0;
}

/**
 * Check if TIN is already registered
 */
export async function isPartyTinRegistered(
  tinDisplay: string,
  countryCode?: string | null
): Promise<boolean> {
  const normalized = normalizeTin(tinDisplay);

  const where: any = {
    tinNormalized: normalized,
    deletedAt: null
  };

  if (countryCode !== undefined) {
    where.countryCode = countryCode;
  }

  const count = await prisma.party.count({ where });

  return count > 0;
}

// ============================================================================
// PARTY SEARCH
// ============================================================================

/**
 * Search parties by name (fuzzy)
 */
export async function searchPartiesByName(
  query: string,
  limit: number = 10
): Promise<Array<{
  id: string;
  displayName: string;
  tinDisplay: string;
  countryCode: string | null;
}>> {
  const normalized = normalizePartyName(query);

  const parties = await prisma.party.findMany({
    where: {
      nameNormalized: {
        contains: normalized
      },
      deletedAt: null
    },
    select: {
      id: true,
      displayName: true,
      tinDisplay: true,
      countryCode: true
    },
    take: limit,
    orderBy: {
      displayName: 'asc'
    }
  });

  return parties;
}

/**
 * Get all active parties
 */
export async function getAllActiveParties(
  countryCode?: string | null
): Promise<Array<{
  id: string;
  displayName: string;
  nameNormalized: string;
  tinDisplay: string;
  tinNormalized: string;
  countryCode: string | null;
  createdAt: Date;
}>> {
  const where: any = {
    deletedAt: null
  };

  if (countryCode !== undefined) {
    where.countryCode = countryCode;
  }

  const parties = await prisma.party.findMany({
    where,
    select: {
      id: true,
      displayName: true,
      nameNormalized: true,
      tinDisplay: true,
      tinNormalized: true,
      countryCode: true,
      createdAt: true
    },
    orderBy: {
      displayName: 'asc'
    }
  });

  return parties;
}
