import { PartyType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getPartyThresholds } from '@/lib/partyThresholds';
import { compareTwoStrings } from 'string-similarity';

// ============================================================================
// CONSTANTS - Buyer Resolution Thresholds
// ============================================================================

const PARTY_THRESHOLDS = getPartyThresholds();

/**
 * Confidence threshold for auto-selecting a buyer match (≥0.92)
 * Matches at or above this threshold are automatically selected without user confirmation.
 */
export const CONFIDENCE_AUTO_SELECT = PARTY_THRESHOLDS.confidenceAutoSelect;

/**
 * Minimum confidence threshold for requiring user confirmation (≥0.86)
 * Matches between 0.86 and 0.9199 require user to confirm the selection.
 */
export const CONFIDENCE_REQUIRE_CONFIRM = PARTY_THRESHOLDS.confidenceRequireConfirm;

/**
 * Maximum number of candidates to return for user selection
 */
export const MAX_CANDIDATES = PARTY_THRESHOLDS.maxCandidates;

/**
 * Score proximity threshold for tie detection (0.02)
 * If multiple candidates are within this range, they are considered tied.
 */
export const TIE_PROXIMITY_THRESHOLD = PARTY_THRESHOLDS.tieProximityThreshold;

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
      deletedAt: null,
      partyType: 'buyer'
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
    deletedAt: null,
    partyType: 'buyer'
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
      deletedAt: null,
      partyType: 'buyer'
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
  countryCode?: string | null,
  partyType: PartyType = 'buyer'
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
    deletedAt: null,
    partyType
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

// ============================================================================
// BUYER RESOLUTION UTILITIES
// ============================================================================

/**
 * Calculate token overlap between two normalized strings
 * Returns the number of common tokens (words) between the strings
 */
function getTokenOverlap(str1: string, str2: string): number {
  const tokens1 = new Set(str1.split(/\s+/).filter(t => t.length > 0));
  const tokens2 = new Set(str2.split(/\s+/).filter(t => t.length > 0));

  let overlap = 0;
  for (const token of tokens1) {
    if (tokens2.has(token)) {
      overlap++;
    }
  }
  return overlap;
}

/**
 * Check if one string is a prefix or substring of another
 */
function hasSubstringContainment(str1: string, str2: string): boolean {
  return str1.includes(str2) || str2.includes(str1);
}

interface ScoredCandidate {
  id: string;
  displayName: string;
  nameNormalized: string;
  tinDisplay: string;
  tinNormalized: string;
  countryCode: string | null;
  addressFull: string | null;
  email: string | null;
  buyerDocument: string | null;
  buyerDocumentNumber: string | null;
  buyerIdtku: string | null;
  transactionCode: string | null;
  score: number;
  tokenOverlap: number;
}

/**
 * Deterministic tie-breaker for candidates with similar scores
 * Tie-breaking order:
 * 1. Higher composite score
 * 2. Greater token overlap count
 * 3. Prefix/substring containment
 * 4. Lexicographically smallest name_normalized
 *
 * Returns the winning candidate, or null if there's a true tie
 */
function breakTie(
  candidates: ScoredCandidate[],
  queryNormalized: string
): ScoredCandidate | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Sort by the tie-breaking criteria
  const sorted = [...candidates].sort((a, b) => {
    // 1. Higher score wins
    if (Math.abs(a.score - b.score) > 0.000001) {
      return b.score - a.score;
    }

    // 2. Greater token overlap wins
    if (a.tokenOverlap !== b.tokenOverlap) {
      return b.tokenOverlap - a.tokenOverlap;
    }

    // 3. Substring containment wins
    const aContains = hasSubstringContainment(a.nameNormalized, queryNormalized);
    const bContains = hasSubstringContainment(b.nameNormalized, queryNormalized);
    if (aContains && !bContains) return -1;
    if (!aContains && bContains) return 1;

    // 4. Lexicographically smaller wins (deterministic)
    return a.nameNormalized.localeCompare(b.nameNormalized);
  });

  // Check if top 2 are truly tied (same score, overlap, and containment)
  if (sorted.length > 1) {
    const top = sorted[0];
    const second = sorted[1];

    const scoreTied = Math.abs(top.score - second.score) < 0.000001;
    const overlapTied = top.tokenOverlap === second.tokenOverlap;
    const containmentTop = hasSubstringContainment(top.nameNormalized, queryNormalized);
    const containmentSecond = hasSubstringContainment(second.nameNormalized, queryNormalized);
    const containmentTied = containmentTop === containmentSecond;

    if (scoreTied && overlapTied && containmentTied) {
      // True tie - require manual resolution
      return null;
    }
  }

  return sorted[0];
}

// ============================================================================
// BUYER RESOLUTION - Main Functions
// ============================================================================

export interface ResolvedParty {
  id: string;
  displayName: string;
  nameNormalized: string;
  tinDisplay: string;
  tinNormalized: string;
  countryCode: string | null;
  addressFull: string | null;
  email: string | null;
  buyerDocument: string | null;
  buyerDocumentNumber: string | null;
  buyerIdtku: string | null;
  transactionCode: string | null;
}

export interface CandidateParty extends ResolvedParty {
  confidence: number;
}

export type BuyerResolutionResult =
  | { status: 'resolved'; party: ResolvedParty; confidence: number }
  | { status: 'candidates'; candidates: CandidateParty[]; topConfidence: number }
  | { status: 'unresolved'; candidates: CandidateParty[] }
  | { status: 'conflict'; exactParty: ResolvedParty; fuzzyCandidate: ScoredCandidate }
  | { status: 'data_error'; duplicates: ResolvedParty[]; message: string };

/**
 * Resolve buyer party using exact-then-fuzzy matching strategy
 *
 * Stage 1: Exact match on name_normalized
 * Stage 2: Fuzzy match using Dice coefficient with thresholds:
 *   - ≥0.92: Auto-select (if no close ties)
 *   - 0.86-0.9199: Require user confirmation
 *   - <0.86: Unresolved (show top candidates)
 *
 * @param buyerName - The buyer name from the parsed invoice
 * @returns Resolution result with status and party/candidates
 */
export async function resolveBuyerParty(
  buyerName: string
): Promise<BuyerResolutionResult> {
  const normalized = normalizePartyName(buyerName);

  // STAGE 1: Exact match on name_normalized
  const exactMatches = await prisma.party.findMany({
    where: {
      nameNormalized: normalized,
      deletedAt: null,
      partyType: 'buyer'
    },
    select: {
      id: true,
      displayName: true,
      nameNormalized: true,
      tinDisplay: true,
      tinNormalized: true,
      countryCode: true,
      addressFull: true,
      email: true,
      buyerDocument: true,
      buyerDocumentNumber: true,
      buyerIdtku: true,
      transactionCode: true
    }
  });

  // Data integrity check: Multiple parties with same normalized name
  if (exactMatches.length > 1) {
    return {
      status: 'data_error',
      duplicates: exactMatches,
      message: `Found ${exactMatches.length} parties with normalized name "${normalized}". Requires admin cleanup (merge/delete duplicates).`
    };
  }

  // Exact match found - return immediately with confidence 1.0
  if (exactMatches.length === 1) {
    return {
      status: 'resolved',
      party: exactMatches[0],
      confidence: 1.0
    };
  }

  // STAGE 2: Fuzzy matching - query all active parties
  const allParties = await prisma.party.findMany({
    where: {
      deletedAt: null,
      partyType: 'buyer'
    },
    select: {
      id: true,
      displayName: true,
      nameNormalized: true,
      tinDisplay: true,
      tinNormalized: true,
      countryCode: true,
      addressFull: true,
      email: true,
      buyerDocument: true,
      buyerDocumentNumber: true,
      buyerIdtku: true,
      transactionCode: true
    }
  });

  // Compute fuzzy scores using Dice coefficient
  const scored: ScoredCandidate[] = allParties.map(party => {
    const score = compareTwoStrings(normalized, party.nameNormalized);
    const tokenOverlap = getTokenOverlap(normalized, party.nameNormalized);

    return {
      ...party,
      score,
      tokenOverlap
    };
  });

  // Sort all candidates by score descending
  const sortedCandidates = scored.sort((a, b) => b.score - a.score);

  // Filter candidates that meet minimum confidence threshold
  const validCandidates = sortedCandidates.filter(c => c.score >= CONFIDENCE_REQUIRE_CONFIRM);

  // No candidates above minimum threshold
  if (validCandidates.length === 0) {
    // Return ALL parties sorted by score for manual selection
    const allCandidates = sortedCandidates.map(c => ({
      ...c,
      confidence: c.score
    }));

    return {
      status: 'unresolved',
      candidates: allCandidates
    };
  }

  const topCandidate = validCandidates[0];
  const topScore = topCandidate.score;

  // Check for high-confidence auto-select (≥0.92)
  if (topScore >= CONFIDENCE_AUTO_SELECT) {
    // Check for close ties (within 0.02 of top score)
    const closeTies = validCandidates.filter(
      c => Math.abs(c.score - topScore) <= TIE_PROXIMITY_THRESHOLD
    );

    if (closeTies.length > 1) {
      // Multiple candidates within tie threshold - apply tie-breaker
      const winner = breakTie(closeTies, normalized);

      if (!winner) {
        // True tie detected - require manual confirmation
        // Return ALL parties sorted by score
        const allCandidates = sortedCandidates.map(c => ({
          ...c,
          confidence: c.score
        }));

        return {
          status: 'candidates',
          candidates: allCandidates,
          topConfidence: topScore
        };
      }

      // Tie-breaker succeeded - auto-select winner
      return {
        status: 'resolved',
        party: winner,
        confidence: winner.score
      };
    }

    // Single high-confidence match - auto-select
    return {
      status: 'resolved',
      party: topCandidate,
      confidence: topScore
    };
  }

  // Medium confidence (0.86-0.9199) - require user confirmation
  // Return ALL parties sorted by score
  const allCandidates = sortedCandidates.map(c => ({
    ...c,
    confidence: c.score
  }));

  return {
    status: 'candidates',
    candidates: allCandidates,
    topConfidence: topScore
  };
}

/**
 * Validate that a buyer party ID exists and is not deleted
 * @param partyId - UUID of the party to validate
 * @returns The party if valid, null otherwise
 */
export async function validateBuyerPartyId(
  partyId: string
): Promise<ResolvedParty | null> {
  const party = await prisma.party.findUnique({
    where: { id: partyId },
    select: {
      id: true,
      displayName: true,
      nameNormalized: true,
      tinDisplay: true,
      tinNormalized: true,
      countryCode: true,
      addressFull: true,
      email: true,
      buyerDocument: true,
      buyerDocumentNumber: true,
      buyerIdtku: true,
      transactionCode: true,
      deletedAt: true,
      partyType: true
    }
  });

  if (!party || party.deletedAt || party.partyType !== 'buyer') {
    return null;
  }

  const { deletedAt, partyType: _partyType, ...validParty } = party;
  return validParty;
}
