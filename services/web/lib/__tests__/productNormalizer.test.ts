/**
 * Product Normalizer Tests
 *
 * Run with: npx ts-node lib/__tests__/productNormalizer.test.ts
 */

import {
  normalizeProductDescription,
  tokenize,
  removeStopWords,
  generateNGrams,
  generateAllNGrams,
  normalizeForIndexing,
} from '../productNormalizer';

// Simple test framework
let passedTests = 0;
let failedTests = 0;

function assertEquals(actual: any, expected: any, testName: string) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);

  if (actualStr === expectedStr) {
    console.log(`✓ ${testName}`);
    passedTests++;
  } else {
    console.log(`✗ ${testName}`);
    console.log(`  Expected: ${expectedStr}`);
    console.log(`  Actual:   ${actualStr}`);
    failedTests++;
  }
}

function assertContains(array: string[], value: string, testName: string) {
  if (array.includes(value)) {
    console.log(`✓ ${testName}`);
    passedTests++;
  } else {
    console.log(`✗ ${testName}`);
    console.log(`  Expected array to contain: ${value}`);
    console.log(`  Actual array: ${JSON.stringify(array)}`);
    failedTests++;
  }
}

console.log('\n=== Product Normalizer Tests ===\n');

// Test normalizeProductDescription
console.log('--- normalizeProductDescription ---');
assertEquals(
  normalizeProductDescription('  Laptop  HP   '),
  'laptop hp',
  'should trim and normalize whitespace'
);

assertEquals(
  normalizeProductDescription('Product: Laptop HP'),
  'laptop hp',
  'should remove "Product:" prefix'
);

assertEquals(
  normalizeProductDescription('Laptop HP (New)'),
  'laptop hp',
  'should remove special characters'
);

assertEquals(
  normalizeProductDescription('Laptop-HP/2024'),
  'laptop-hp/2024',
  'should keep hyphens and slashes'
);

assertEquals(
  normalizeProductDescription(''),
  '',
  'should handle empty string'
);

// Test tokenize
console.log('\n--- tokenize ---');
assertEquals(
  tokenize('laptop hp pavilion'),
  ['laptop', 'hp', 'pavilion'],
  'should split into tokens'
);

assertEquals(
  tokenize('laptop   hp   pavilion'),
  ['laptop', 'hp', 'pavilion'],
  'should handle multiple spaces'
);

assertEquals(
  tokenize(''),
  [],
  'should return empty array for empty string'
);

// Test removeStopWords
console.log('\n--- removeStopWords ---');
assertEquals(
  removeStopWords(['the', 'laptop', 'is', 'new']),
  ['laptop', 'new'],
  'should remove English stop words'
);

assertEquals(
  removeStopWords(['laptop', 'dan', 'mouse']),
  ['laptop', 'mouse'],
  'should remove Indonesian stop words'
);

assertEquals(
  removeStopWords(['laptop', 'unit', 'pcs']),
  ['laptop'],
  'should remove product filler words'
);

// Test generateNGrams
console.log('\n--- generateNGrams ---');
assertEquals(
  generateNGrams(['laptop', 'hp', 'pavilion'], 2),
  ['laptop hp', 'hp pavilion'],
  'should generate bigrams'
);

assertEquals(
  generateNGrams(['laptop', 'hp', 'pavilion'], 3),
  ['laptop hp pavilion'],
  'should generate trigrams'
);

assertEquals(
  generateNGrams(['laptop'], 2),
  [],
  'should return empty for insufficient tokens'
);

// Test generateAllNGrams
console.log('\n--- generateAllNGrams ---');
const allNGrams = generateAllNGrams(['laptop', 'hp'], 2);
assertEquals(
  allNGrams.length,
  3,
  'should generate correct number of n-grams'
);
assertContains(allNGrams, 'laptop', 'should contain unigram');
assertContains(allNGrams, 'hp', 'should contain unigram');
assertContains(allNGrams, 'laptop hp', 'should contain bigram');

// Test normalizeForIndexing
console.log('\n--- normalizeForIndexing ---');
const indexed = normalizeForIndexing('Product: Laptop HP Pavilion (New)');
assertEquals(
  indexed.original,
  'Product: Laptop HP Pavilion (New)',
  'should preserve original'
);
assertEquals(
  indexed.normalized,
  'laptop hp pavilion',
  'should normalize correctly'
);
assertContains(
  indexed.tokens,
  'laptop',
  'should tokenize correctly'
);
assertContains(
  indexed.bigrams,
  'laptop hp',
  'should generate bigrams'
);

// Test Indonesian product descriptions
console.log('\n--- Indonesian descriptions ---');
const indonesian = normalizeForIndexing('Barang: Laptop untuk kantor');
assertEquals(
  indonesian.normalized,
  'laptop untuk kantor',
  'should normalize Indonesian text (remove prefix)'
);
assertEquals(
  indonesian.tokensWithoutStopWords.join(' '),
  'laptop kantor',
  'should remove Indonesian stop words from tokens'
);

// Summary
console.log('\n=== Test Summary ===');
console.log(`Passed: ${passedTests}`);
console.log(`Failed: ${failedTests}`);
console.log(`Total:  ${passedTests + failedTests}`);

if (failedTests === 0) {
  console.log('\n✓ All tests passed!');
  process.exit(0);
} else {
  console.log(`\n✗ ${failedTests} test(s) failed`);
  process.exit(1);
}
