/**
 * Product Enrichment End-to-End Test
 *
 * Tests the complete enrichment flow:
 * 1. Seed test products to database
 * 2. Refresh live index
 * 3. Test auto-enrichment with score >= 0.80
 * 4. Test no enrichment with score < 0.80
 * 5. Test draft creation from manual entry
 * 6. Verify enrichment events are logged
 *
 * Run with: npx tsx lib/__tests__/productEnrichment.test.ts
 */

import { prisma } from '../prisma';
import { refreshLiveIndex } from '../productIndexer';
import { enrichProductDescription, createDraftFromManualEntry } from '../productEnrichment';

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

async function setup() {
  console.log('\n=== Setting up test data ===\n');

  // Clean up any existing test data
  await prisma.enrichmentEvent.deleteMany({
    where: { invoiceId: { startsWith: 'TEST_' } },
  });

  await prisma.productDraft.deleteMany({
    where: { sourceInvoiceId: { startsWith: 'TEST_' } },
  });

  await prisma.product.deleteMany({
    where: { description: { startsWith: 'TEST_' } },
  });

  // Ensure required UOM codes exist
  await prisma.unitOfMeasure.upsert({
    where: { code: 'UNIT' },
    update: {},
    create: { code: 'UNIT', name: 'Unit' },
  });

  await prisma.unitOfMeasure.upsert({
    where: { code: 'JAM' },
    update: {},
    create: { code: 'JAM', name: 'Jam' },
  });

  await prisma.unitOfMeasure.upsert({
    where: { code: 'PCS' },
    update: {},
    create: { code: 'PCS', name: 'Pieces' },
  });

  // Create test products
  const products = await Promise.all([
    prisma.product.create({
      data: {
        description: 'TEST_Laptop HP Pavilion 15',
        hsCode: '847130',
        type: 'BARANG',
        uomCode: 'UNIT',
        status: 'active',
        createdBy: 'test',
      },
    }),
    prisma.product.create({
      data: {
        description: 'TEST_Mouse Logitech Wireless',
        hsCode: '847160',
        type: 'BARANG',
        uomCode: 'UNIT',
        status: 'active',
        createdBy: 'test',
      },
    }),
    prisma.product.create({
      data: {
        description: 'TEST_Jasa Konsultasi IT',
        hsCode: '840990',
        type: 'JASA',
        uomCode: 'JAM',
        status: 'active',
        createdBy: 'test',
      },
    }),
  ]);

  console.log(`Created ${products.length} test products`);

  // Refresh live index to include test products
  await refreshLiveIndex();
  console.log('Live index refreshed\n');

  return products;
}

async function teardown() {
  console.log('\n=== Cleaning up test data ===\n');

  await prisma.enrichmentEvent.deleteMany({
    where: { invoiceId: { startsWith: 'TEST_' } },
  });

  await prisma.productDraft.deleteMany({
    where: { sourceInvoiceId: { startsWith: 'TEST_' } },
  });

  await prisma.product.deleteMany({
    where: { description: { startsWith: 'TEST_' } },
  });

  console.log('Test data cleaned up');
}

async function runTests() {
  console.log('\n=== Product Enrichment Tests ===\n');

  const products = await setup();

  try {
    // Test 1: Auto-enrichment with exact match (score = 1.0)
    console.log('--- Test 1: Exact match auto-enrichment ---');
    const result1 = await enrichProductDescription({
      description: 'TEST_Laptop HP Pavilion 15',
      invoiceId: 'TEST_INV_001',
      lineItemIndex: 0,
      threshold: 0.8,
      createdBy: 'test',
    });

    assert(result1.matched === true, 'should match product');
    assert(result1.autoFilled === true, 'should auto-fill with exact match');
    assert(result1.matchScore === 1.0, `should have score 1.0 (got ${result1.matchScore})`);
    assert(result1.enrichedFields !== null, 'should return enriched fields');
    assert(result1.enrichedFields?.hsCode === '847130', `should enrich HS code (got ${result1.enrichedFields?.hsCode})`);
    assert(result1.enrichedFields?.type === 'BARANG', `should enrich type (got ${result1.enrichedFields?.type})`);
    assert(result1.enrichedFields?.uomCode === 'UNIT', `should enrich UOM (got ${result1.enrichedFields?.uomCode})`);

    // Verify event was logged
    const event1 = await prisma.enrichmentEvent.findUnique({
      where: { id: result1.eventId },
    });
    assert(event1 !== null, 'should log enrichment event');
    assert(event1?.autoFilled === true, 'event should mark as auto-filled');

    // Test 2: Similar description (should still auto-fill if score >= 0.80)
    console.log('\n--- Test 2: Similar description ---');
    const result2 = await enrichProductDescription({
      description: 'TEST_Laptop HP Pavilion',
      invoiceId: 'TEST_INV_002',
      lineItemIndex: 0,
      threshold: 0.8,
      createdBy: 'test',
    });

    assert(result2.matched === true, 'should match product');
    console.log(`  Match score: ${result2.matchScore?.toFixed(3)}`);

    if (result2.matchScore && result2.matchScore >= 0.8) {
      assert(result2.autoFilled === true, 'should auto-fill with high score');
      assert(result2.enrichedFields !== null, 'should return enriched fields');
    } else {
      assert(result2.autoFilled === false, 'should not auto-fill with low score');
      assert(result2.enrichedFields === null, 'should not return enriched fields');
    }

    // Test 3: Low score match (should not auto-fill)
    console.log('\n--- Test 3: Low score - no auto-fill ---');
    const result3 = await enrichProductDescription({
      description: 'TEST_Laptop Unknown Brand',
      invoiceId: 'TEST_INV_003',
      lineItemIndex: 0,
      threshold: 0.8,
      createdBy: 'test',
    });

    console.log(`  Best match score: ${result3.matchScore?.toFixed(3) || 'none'}`);
    assert(result3.autoFilled === false, 'should not auto-fill with low score');
    assert(result3.enrichedFields === null, 'should not return enriched fields');

    // Event should still be logged
    const event3 = await prisma.enrichmentEvent.findUnique({
      where: { id: result3.eventId },
    });
    assert(event3 !== null, 'should log event even without auto-fill');
    assert(event3?.autoFilled === false, 'event should mark as not auto-filled');

    // Test 4: No match at all
    console.log('\n--- Test 4: No match ---');
    const result4 = await enrichProductDescription({
      description: 'TEST_Completely Unrelated Product XYZ123',
      invoiceId: 'TEST_INV_004',
      lineItemIndex: 0,
      threshold: 0.8,
      createdBy: 'test',
    });

    console.log(`  Match score: ${result4.matchScore?.toFixed(3) || 'none'}`);
    assert(result4.autoFilled === false, 'should not auto-fill with no match');
    assert(result4.enrichedFields === null, 'should not return enriched fields');

    // Test 5: Create draft from manual entry
    console.log('\n--- Test 5: Draft creation from manual entry ---');
    const draft = await createDraftFromManualEntry({
      description: 'TEST_New Product Manual Entry',
      hsCode: '123456',
      type: 'BARANG',
      uomCode: 'PCS',
      sourceInvoiceId: 'TEST_INV_005',
      enrichmentEventId: result4.eventId,
      createdBy: 'test',
    });

    assert(draft !== null, 'should create draft');
    assert(draft.kind === 'new_product', 'draft should be new_product kind');
    assert(draft.status === 'draft', 'draft should have draft status');
    assert(draft.description === 'TEST_New Product Manual Entry', 'draft should preserve description');
    assert(draft.hsCode === '123456', 'draft should preserve HS code');

    // Verify event was updated with draft link
    const updatedEvent = await prisma.enrichmentEvent.findUnique({
      where: { id: result4.eventId },
    });
    assert(updatedEvent?.draftCreated === true, 'event should mark draft as created');
    assert(updatedEvent?.draftId === draft.id, 'event should link to draft');

    // Test 6: Custom threshold
    console.log('\n--- Test 6: Custom threshold ---');
    const result6 = await enrichProductDescription({
      description: 'TEST_Mouse Logitech',
      invoiceId: 'TEST_INV_006',
      lineItemIndex: 0,
      threshold: 0.5, // Lower threshold
      createdBy: 'test',
    });

    console.log(`  Match score: ${result6.matchScore?.toFixed(3)}`);
    if (result6.matchScore && result6.matchScore >= 0.5) {
      assert(result6.autoFilled === true, 'should auto-fill with custom threshold');
    }

  } finally {
    await teardown();
  }
}

// Run tests
runTests()
  .then(() => {
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
  })
  .catch((error) => {
    console.error('\n✗ Test execution failed:', error);
    process.exit(1);
  });
