/**
 * Product Description Normalizer
 *
 * Provides text normalization utilities for product descriptions to improve
 * matching accuracy by standardizing text format, removing noise, and
 * handling common variations.
 */

/**
 * Normalizes a product description for matching purposes
 *
 * Steps:
 * 1. Convert to lowercase
 * 2. Remove extra whitespace
 * 3. Remove special characters (keep alphanumeric and spaces)
 * 4. Trim leading/trailing spaces
 * 5. Remove common filler words
 *
 * @param description - Raw product description
 * @returns Normalized description string
 */
export function normalizeProductDescription(description: string): string {
  if (!description || typeof description !== 'string') {
    return '';
  }

  let normalized = description.trim();

  // Convert to lowercase
  normalized = normalized.toLowerCase();

  // Remove common prefixes BEFORE removing special characters
  // This allows us to match patterns with colons
  const prefixPatterns = [
    /^(product|item|barang|jasa):\s*/i,
  ];

  prefixPatterns.forEach(pattern => {
    normalized = normalized.replace(pattern, '');
  });

  // Remove special characters but keep alphanumeric, spaces, and basic punctuation
  // Keep: letters, numbers, spaces, hyphens, slashes
  normalized = normalized.replace(/[^a-z0-9\s\-\/]/g, ' ');

  // Replace multiple whitespace with single space
  normalized = normalized.replace(/\s+/g, ' ');

  // Remove common filler words
  const fillerPatterns = [
    /\s*(new|baru|bekas|used)\s*$/i,
    /\s+(new|baru|bekas|used)\s+/i,
  ];

  fillerPatterns.forEach(pattern => {
    normalized = normalized.replace(pattern, ' ');
  });

  // Replace multiple whitespace with single space (again after removals)
  normalized = normalized.replace(/\s+/g, ' ');

  // Clean up any double spaces created by removals
  normalized = normalized.replace(/\s+/g, ' ');

  // Final trim
  normalized = normalized.trim();

  return normalized;
}

/**
 * Tokenizes a normalized description into words
 *
 * @param normalizedDescription - Normalized product description
 * @returns Array of tokens (words)
 */
export function tokenize(normalizedDescription: string): string[] {
  if (!normalizedDescription) {
    return [];
  }

  // Split on whitespace and filter empty strings
  const tokens = normalizedDescription
    .split(/\s+/)
    .filter(token => token.length > 0);

  return tokens;
}

/**
 * Removes common stop words that don't add semantic value
 *
 * @param tokens - Array of tokens
 * @returns Filtered array of tokens without stop words
 */
export function removeStopWords(tokens: string[]): string[] {
  // Common Indonesian and English stop words for product descriptions
  const stopWords = new Set([
    // English
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those',

    // Indonesian
    'dan', 'atau', 'dari', 'untuk', 'pada', 'di', 'ke', 'dengan', 'yang',
    'adalah', 'ini', 'itu', 'tersebut', 'dalam', 'oleh', 'sebagai', 'akan',
    'telah', 'sudah', 'belum', 'dapat', 'bisa', 'harus', 'perlu',

    // Common product fillers
    'unit', 'piece', 'pcs', 'buah', 'lembar', 'set'
  ]);

  return tokens.filter(token => !stopWords.has(token));
}

/**
 * Generates n-grams from tokens
 *
 * N-grams are contiguous sequences of n tokens, useful for matching
 * multi-word phrases and partial matches.
 *
 * @param tokens - Array of tokens
 * @param n - N-gram size (2 for bigrams, 3 for trigrams, etc.)
 * @returns Array of n-grams as space-separated strings
 */
export function generateNGrams(tokens: string[], n: number): string[] {
  if (n < 1 || tokens.length < n) {
    return [];
  }

  const ngrams: string[] = [];

  for (let i = 0; i <= tokens.length - n; i++) {
    const ngram = tokens.slice(i, i + n).join(' ');
    ngrams.push(ngram);
  }

  return ngrams;
}

/**
 * Generates all n-grams from unigrams to specified max n
 *
 * @param tokens - Array of tokens
 * @param maxN - Maximum n-gram size (default: 3)
 * @returns Array of all n-grams
 */
export function generateAllNGrams(tokens: string[], maxN: number = 3): string[] {
  const allNGrams: string[] = [];

  for (let n = 1; n <= Math.min(maxN, tokens.length); n++) {
    const ngrams = generateNGrams(tokens, n);
    allNGrams.push(...ngrams);
  }

  return allNGrams;
}

/**
 * Complete normalization and tokenization pipeline for indexing
 *
 * @param description - Raw product description
 * @param options - Normalization options
 * @returns Object containing normalized text, tokens, and n-grams
 */
export interface NormalizedProduct {
  original: string;
  normalized: string;
  tokens: string[];
  tokensWithoutStopWords: string[];
  bigrams: string[];
  trigrams: string[];
  allNGrams: string[];
}

export function normalizeForIndexing(
  description: string,
  options: {
    removeStopWords?: boolean;
    maxNGramSize?: number;
  } = {}
): NormalizedProduct {
  const { removeStopWords: shouldRemoveStopWords = true, maxNGramSize = 3 } = options;

  const normalized = normalizeProductDescription(description);
  const tokens = tokenize(normalized);
  const tokensWithoutStopWords = shouldRemoveStopWords ? removeStopWords(tokens) : tokens;

  // Generate n-grams from tokens without stop words for better matching
  const tokensForNGrams = tokensWithoutStopWords;
  const bigrams = generateNGrams(tokensForNGrams, 2);
  const trigrams = generateNGrams(tokensForNGrams, 3);
  const allNGrams = generateAllNGrams(tokensForNGrams, maxNGramSize);

  return {
    original: description,
    normalized,
    tokens,
    tokensWithoutStopWords,
    bigrams,
    trigrams,
    allNGrams,
  };
}
