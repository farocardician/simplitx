/**
 * Product Matcher Tests
 *
 * Run with: npx ts-node lib/__tests__/productMatcher.test.ts
 */

import {
  matchDescriptions,
  matchAgainstCandidates,
  findBestMatch,
  type ProductCandidate,
} from '../productMatcher';

// Simple test framework
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, message?: string) {
  if (condition) {
    console.log(`✓ ${testName}`);
    passedTests++;
  } else {
    console.log(`✗ ${testName}`);
    if (message) {
      console.log(`  ${message}`);
    }
    failedTests++;
  }
}

function assertGreaterThan(actual: number, threshold: number, testName: string) {
  if (actual > threshold) {
    console.log(`✓ ${testName} (score: ${actual.toFixed(3)})`);
    passedTests++;
  } else {
    console.log(`✗ ${testName}`);
    console.log(`  Expected score > ${threshold}, got ${actual.toFixed(3)}`);
    failedTests++;
  }
}

function assertLessThan(actual: number, threshold: number, testName: string) {
  if (actual < threshold) {
    console.log(`✓ ${testName} (score: ${actual.toFixed(3)})`);
    passedTests++;
  } else {
    console.log(`✗ ${testName}`);
    console.log(`  Expected score < ${threshold}, got ${actual.toFixed(3)}`);
    failedTests++;
  }
}

console.log('\n=== Product Matcher Tests ===\n');

// Test exact match
console.log('--- Exact matches ---');
const exactMatch = matchDescriptions('Laptop HP Pavilion', 'Laptop HP Pavilion');
assert(exactMatch.score === 1.0, 'should return 1.0 for exact match');
assert(exactMatch.details.exactMatch === true, 'should flag as exact match');

// Test very similar descriptions
console.log('\n--- Similar descriptions ---');
const similar1 = matchDescriptions('Laptop HP Pavilion 15', 'Laptop HP Pavilion');
assertGreaterThan(similar1.score, 0.70, 'should score high for very similar descriptions');

const similar2 = matchDescriptions('Laptop HP', 'Laptop HP Pavilion');
assertGreaterThan(similar2.score, 0.50, 'should score moderately for partial matches');

// Test different descriptions
console.log('\n--- Different descriptions ---');
const different = matchDescriptions('Laptop HP', 'Mouse Logitech');
assertLessThan(different.score, 0.30, 'should score low for different products');

// Test with typos and variations
console.log('\n--- Typos and variations ---');
const typo = matchDescriptions('Laptop HP Pavilon', 'Laptop HP Pavilion');
assertGreaterThan(typo.score, 0.40, 'should handle minor typos');

const variation1 = matchDescriptions('HP Laptop Pavilion', 'Laptop HP Pavilion');
assertGreaterThan(variation1.score, 0.50, 'should handle word order variations');

// Test case insensitivity
console.log('\n--- Case insensitivity ---');
const caseTest = matchDescriptions('LAPTOP HP PAVILION', 'laptop hp pavilion');
assert(caseTest.score === 1.0, 'should be case insensitive');

// Test with noise words
console.log('\n--- Noise words ---');
const noise = matchDescriptions(
  'Product: Laptop HP Pavilion (New)',
  'Laptop HP Pavilion'
);
assertGreaterThan(noise.score, 0.90, 'should handle noise words well');

// Test Indonesian descriptions
console.log('\n--- Indonesian descriptions ---');
const indonesian = matchDescriptions(
  'Laptop untuk kantor',
  'Laptop kantor'
);
assertGreaterThan(indonesian.score, 0.80, 'should handle Indonesian text');

// Test matchAgainstCandidates
console.log('\n--- matchAgainstCandidates ---');

const candidates: ProductCandidate[] = [
  {
    id: '1',
    description: 'Laptop HP Pavilion 15',
    hsCode: '847130',
    type: 'BARANG',
    uomCode: 'UNIT',
    status: 'active',
  },
  {
    id: '2',
    description: 'Laptop Dell Inspiron',
    hsCode: '847130',
    type: 'BARANG',
    uomCode: 'UNIT',
    status: 'active',
  },
  {
    id: '3',
    description: 'Mouse Logitech',
    hsCode: '847160',
    type: 'BARANG',
    uomCode: 'UNIT',
    status: 'active',
  },
];

const matches = matchAgainstCandidates('Laptop HP Pavilion', candidates, 0.45);
assert(matches.length > 0, 'should return matches above threshold');
if (matches.length > 0) {
  assert(
    matches[0].id === '1',
    'should rank HP laptop highest for "Laptop HP Pavilion" query'
  );
}
if (matches.length > 1) {
  assert(
    matches[0].matchScore > matches[1].matchScore,
    'should sort by score descending'
  );
}

// Test findBestMatch
console.log('\n--- findBestMatch ---');

const bestMatch = findBestMatch('Laptop HP Pavilion', candidates, 0.70);
assert(bestMatch !== null, 'should find best match above threshold');
assert(bestMatch?.id === '1', 'should return correct best match');

const noMatch = findBestMatch('Smartphone Samsung', candidates, 0.80);
assert(noMatch === null, 'should return null when no match above threshold');

// Test threshold behavior
console.log('\n--- Threshold behavior ---');

const lowThreshold = findBestMatch('Mouse', candidates, 0.50);
assert(lowThreshold !== null, 'should find match with low threshold');

const highThreshold = findBestMatch('Mouse', candidates, 0.99);
assert(highThreshold === null, 'should not find match with very high threshold');

// Test with empty candidates
console.log('\n--- Edge cases ---');

const emptyMatch = matchAgainstCandidates('Laptop HP', [], 0.5);
assert(emptyMatch.length === 0, 'should handle empty candidates list');

const emptyBest = findBestMatch('Laptop HP', [], 0.8);
assert(emptyBest === null, 'should return null for empty candidates');

// Test score details
console.log('\n--- Score details ---');

const detailed = matchDescriptions('Laptop HP Pavilion', 'Laptop HP');
assert(
  detailed.details.tokenOverlap > 0,
  'should calculate token overlap'
);
assert(
  detailed.details.jaroWinkler > 0,
  'should calculate Jaro-Winkler distance'
);

// Test real-world scenarios
console.log('\n--- Real-world scenarios ---');

const scenario1 = matchDescriptions(
  'Jasa Konsultasi IT',
  'Jasa Konsultasi Teknologi Informasi'
);
assertGreaterThan(scenario1.score, 0.30, 'should match related service descriptions');

const scenario2 = matchDescriptions(
  'Kertas A4 80gram',
  'Kertas A4 70 gram'
);
assertGreaterThan(scenario2.score, 0.35, 'should match similar products with different specs');

const scenario3 = matchDescriptions(
  'Air Mineral Botol 600ml',
  'Air Mineral Kemasan 600ml'
);
assertGreaterThan(scenario3.score, 0.40, 'should match product variations');

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
