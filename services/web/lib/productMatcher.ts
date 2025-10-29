/**
 * Product Matcher
 *
 * Provides fuzzy matching and similarity scoring for product descriptions
 * using token-based, n-gram-based, and character-based metrics.
 */

import { normalizeForIndexing, type NormalizedProduct } from './productNormalizer';

/**
 * Match result with score and details
 */
export interface MatchResult {
  score: number;
  details: {
    tokenOverlap: number;
    bigramOverlap: number;
    trigramOverlap: number;
    jaroWinkler: number;
    exactMatch: boolean;
  };
}

/**
 * Calculates Jaccard similarity between two sets
 *
 * Jaccard(A, B) = |A ∩ B| / |A ∪ B|
 *
 * @param setA - First set of items
 * @param setB - Second set of items
 * @returns Jaccard similarity coefficient (0 to 1)
 */
function jaccardSimilarity<T>(setA: Set<T>, setB: Set<T>): number {
  if (setA.size === 0 && setB.size === 0) {
    return 1.0; // Both empty sets are considered identical
  }

  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);

  return intersection.size / union.size;
}

/**
 * Calculates Jaro distance between two strings
 *
 * @param s1 - First string
 * @param s2 - Second string
 * @returns Jaro distance (0 to 1)
 */
function jaroDistance(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;

  const matchWindow = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  if (matchWindow < 0) return 0.0;

  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Find matches
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3.0;
}

/**
 * Calculates Jaro-Winkler similarity
 *
 * Jaro-Winkler adds a prefix bonus to the Jaro distance, giving more weight
 * to strings that match from the beginning.
 *
 * @param s1 - First string
 * @param s2 - Second string
 * @param prefixScale - Scaling factor for prefix bonus (default: 0.1)
 * @returns Jaro-Winkler similarity (0 to 1)
 */
function jaroWinklerSimilarity(s1: string, s2: string, prefixScale: number = 0.1): number {
  const jaro = jaroDistance(s1, s2);

  // Calculate common prefix length (max 4 characters)
  let prefixLength = 0;
  const maxPrefixLength = Math.min(4, Math.min(s1.length, s2.length));

  for (let i = 0; i < maxPrefixLength; i++) {
    if (s1[i] === s2[i]) {
      prefixLength++;
    } else {
      break;
    }
  }

  return jaro + prefixLength * prefixScale * (1 - jaro);
}

/**
 * Matches a query description against a target description
 *
 * Scoring algorithm:
 * - Token overlap (40%): Jaccard similarity of tokens without stop words
 * - Bigram overlap (25%): Jaccard similarity of bigrams
 * - Trigram overlap (20%): Jaccard similarity of trigrams
 * - Jaro-Winkler (15%): Character-level similarity of normalized strings
 *
 * @param queryDescription - Query product description
 * @param targetDescription - Target product description to match against
 * @returns Match result with score and details
 */
export function matchDescriptions(
  queryDescription: string,
  targetDescription: string
): MatchResult {
  const query = normalizeForIndexing(queryDescription);
  const target = normalizeForIndexing(targetDescription);

  // Check for exact match
  const exactMatch = query.normalized === target.normalized;

  // Token-based similarity
  const queryTokens = new Set(query.tokensWithoutStopWords);
  const targetTokens = new Set(target.tokensWithoutStopWords);
  const tokenOverlap = jaccardSimilarity(queryTokens, targetTokens);

  // Bigram similarity
  const queryBigrams = new Set(query.bigrams);
  const targetBigrams = new Set(target.bigrams);
  const bigramOverlap = jaccardSimilarity(queryBigrams, targetBigrams);

  // Trigram similarity
  const queryTrigrams = new Set(query.trigrams);
  const targetTrigrams = new Set(target.trigrams);
  const trigramOverlap = jaccardSimilarity(queryTrigrams, targetTrigrams);

  // Character-level similarity
  const jaroWinkler = jaroWinklerSimilarity(query.normalized, target.normalized);

  // Weighted score
  const score =
    tokenOverlap * 0.4 +
    bigramOverlap * 0.25 +
    trigramOverlap * 0.2 +
    jaroWinkler * 0.15;

  return {
    score: exactMatch ? 1.0 : score,
    details: {
      tokenOverlap,
      bigramOverlap,
      trigramOverlap,
      jaroWinkler,
      exactMatch,
    },
  };
}

/**
 * Product match candidate from database
 */
export interface ProductCandidate {
  id: string;
  description: string;
  hsCode?: string | null;
  type?: 'BARANG' | 'JASA' | null;
  uomCode?: string | null;
  status: string;
}

/**
 * Product match with score
 */
export interface ProductMatch extends ProductCandidate {
  matchScore: number;
  matchDetails: MatchResult['details'];
}

/**
 * Matches a query against multiple product candidates and returns ranked results
 *
 * @param queryDescription - Query product description
 * @param candidates - Array of product candidates
 * @param threshold - Minimum score threshold (default: 0.0, return all)
 * @returns Array of matches sorted by score (highest first)
 */
export function matchAgainstCandidates(
  queryDescription: string,
  candidates: ProductCandidate[],
  threshold: number = 0.0
): ProductMatch[] {
  const matches: ProductMatch[] = [];

  for (const candidate of candidates) {
    const result = matchDescriptions(queryDescription, candidate.description);

    if (result.score >= threshold) {
      matches.push({
        ...candidate,
        matchScore: result.score,
        matchDetails: result.details,
      });
    }
  }

  // Sort by score descending
  matches.sort((a, b) => b.matchScore - a.matchScore);

  return matches;
}

/**
 * Finds the best match from candidates
 *
 * @param queryDescription - Query product description
 * @param candidates - Array of product candidates
 * @param minimumScore - Minimum acceptable score (default: 0.8)
 * @returns Best match if above threshold, null otherwise
 */
export function findBestMatch(
  queryDescription: string,
  candidates: ProductCandidate[],
  minimumScore: number = 0.8
): ProductMatch | null {
  const matches = matchAgainstCandidates(queryDescription, candidates, minimumScore);

  if (matches.length === 0) {
    return null;
  }

  return matches[0];
}
