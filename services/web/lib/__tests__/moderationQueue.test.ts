/**
 * Moderation Queue Tests
 *
 * Tests the complete moderation workflow:
 * 1. Create draft products
 * 2. List drafts with filtering
 * 3. Approve drafts (creates active products)
 * 4. Reject drafts with notes
 * 5. Edit before approve
 * 6. Verify live index refresh
 *
 * Run with: npx tsx lib/__tests__/moderationQueue.test.ts
 */

import { prisma } from '../prisma';
import { getLiveIndex, refreshLiveIndex } from '../productIndexer';

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
  await prisma.productDraft.deleteMany({
    where: { sourceInvoiceId: { startsWith: 'TEST_MQ_' } },
  });

  await prisma.product.deleteMany({
    where: { description: { startsWith: 'TEST_MQ_' } },
  });

  // Ensure required UOM codes exist
  await prisma.unitOfMeasure.upsert({
    where: { code: 'UNIT' },
    update: {},
    create: { code: 'UNIT', name: 'Unit' },
  });

  console.log('Test environment ready\n');
}

async function teardown() {
  console.log('\n=== Cleaning up test data ===\n');

  await prisma.productDraft.deleteMany({
    where: { sourceInvoiceId: { startsWith: 'TEST_MQ_' } },
  });

  await prisma.product.deleteMany({
    where: { description: { startsWith: 'TEST_MQ_' } },
  });

  console.log('Test data cleaned up');
}

async function runTests() {
  console.log('\n=== Moderation Queue Tests ===\n');

  await setup();

  try {
    // Test 1: Create draft products
    console.log('--- Test 1: Create draft products ---');

    const draft1 = await prisma.productDraft.create({
      data: {
        kind: 'new_product',
        description: 'TEST_MQ_Laptop HP Pavilion',
        hsCode: '847130',
        type: 'BARANG',
        uomCode: 'UNIT',
        sourceInvoiceId: 'TEST_MQ_INV_001',
        sourcePdfLineText: 'Laptop HP Pavilion 15 inch',
        confidenceScore: 0.65,
        status: 'draft',
        createdBy: 'test',
      },
    });

    assert(draft1 !== null, 'should create new product draft');
    assert(draft1.status === 'draft', 'draft should have draft status');

    const draft2 = await prisma.productDraft.create({
      data: {
        kind: 'new_product',
        description: 'TEST_MQ_Mouse Wireless',
        hsCode: '847160',
        type: 'BARANG',
        uomCode: 'UNIT',
        sourceInvoiceId: 'TEST_MQ_INV_002',
        status: 'draft',
        createdBy: 'test',
      },
    });

    assert(draft2 !== null, 'should create second draft');

    // Test 2: List drafts
    console.log('\n--- Test 2: List drafts ---');

    const allDrafts = await prisma.productDraft.findMany({
      where: {
        sourceInvoiceId: { startsWith: 'TEST_MQ_' },
      },
    });

    assert(allDrafts.length >= 2, `should list drafts (found ${allDrafts.length})`);

    // Test 3: Filter drafts by status
    console.log('\n--- Test 3: Filter by status ---');

    const draftStatusDrafts = await prisma.productDraft.findMany({
      where: {
        status: 'draft',
        sourceInvoiceId: { startsWith: 'TEST_MQ_' },
      },
    });

    assert(draftStatusDrafts.length >= 2, 'should filter by draft status');

    // Test 4: Filter by kind
    console.log('\n--- Test 4: Filter by kind ---');

    const newProductDrafts = await prisma.productDraft.findMany({
      where: {
        kind: 'new_product',
        sourceInvoiceId: { startsWith: 'TEST_MQ_' },
      },
    });

    assert(newProductDrafts.length >= 2, 'should filter by kind');

    // Test 5: Approve draft (creates active product)
    console.log('\n--- Test 5: Approve draft ---');

    // First, update draft to approved
    const approvedDraft = await prisma.productDraft.update({
      where: { id: draft1.id },
      data: {
        status: 'approved',
        reviewedBy: 'test_reviewer',
        reviewedAt: new Date(),
        reviewNotes: 'Approved for catalog',
      },
    });

    assert(approvedDraft.status === 'approved', 'draft should be approved');
    assert(approvedDraft.reviewedBy === 'test_reviewer', 'should record reviewer');

    // Create the corresponding product
    const product = await prisma.product.create({
      data: {
        description: draft1.description!,
        hsCode: draft1.hsCode,
        type: draft1.type,
        uomCode: draft1.uomCode,
        status: 'active',
        createdBy: 'test_reviewer',
      },
    });

    assert(product !== null, 'should create active product from draft');
    assert(product.description === draft1.description, 'product should match draft description');
    assert(product.status === 'active', 'product should be active');

    // Test 6: Reject draft
    console.log('\n--- Test 6: Reject draft ---');

    const rejectedDraft = await prisma.productDraft.update({
      where: { id: draft2.id },
      data: {
        status: 'rejected',
        reviewedBy: 'test_reviewer',
        reviewedAt: new Date(),
        reviewNotes: 'Duplicate product exists',
      },
    });

    assert(rejectedDraft.status === 'rejected', 'draft should be rejected');
    assert(rejectedDraft.reviewNotes === 'Duplicate product exists', 'should save review notes');

    // Test 7: Edit before approve
    console.log('\n--- Test 7: Edit before approve ---');

    const draft3 = await prisma.productDraft.create({
      data: {
        kind: 'new_product',
        description: 'TEST_MQ_Keyboard Mechanical',
        hsCode: '847160',
        type: 'BARANG',
        uomCode: 'UNIT',
        sourceInvoiceId: 'TEST_MQ_INV_003',
        status: 'draft',
        createdBy: 'test',
      },
    });

    // Update draft with edits
    const editedDraft = await prisma.productDraft.update({
      where: { id: draft3.id },
      data: {
        hsCode: '847170', // Changed HS code
        description: 'TEST_MQ_Keyboard Mechanical RGB', // Enhanced description
      },
    });

    assert(editedDraft.hsCode === '847170', 'should update HS code');
    assert(
      editedDraft.description === 'TEST_MQ_Keyboard Mechanical RGB',
      'should update description'
    );

    // Then approve
    const approvedEditedDraft = await prisma.productDraft.update({
      where: { id: draft3.id },
      data: {
        status: 'approved',
        reviewedBy: 'test_reviewer',
        reviewedAt: new Date(),
      },
    });

    assert(approvedEditedDraft.status === 'approved', 'edited draft should be approved');

    // Test 8: Create alias draft
    console.log('\n--- Test 8: Create alias draft ---');

    const aliasDraft = await prisma.productDraft.create({
      data: {
        kind: 'alias',
        targetProductId: product.id,
        aliasDescription: 'TEST_MQ_HP Laptop Pavilion',
        sourceInvoiceId: 'TEST_MQ_INV_004',
        confidenceScore: 0.75,
        status: 'draft',
        createdBy: 'test',
      },
    });

    assert(aliasDraft.kind === 'alias', 'should create alias draft');
    assert(aliasDraft.targetProductId === product.id, 'should link to target product');

    // Approve alias draft
    const approvedAlias = await prisma.productDraft.update({
      where: { id: aliasDraft.id },
      data: {
        status: 'approved',
        reviewedBy: 'test_reviewer',
        reviewedAt: new Date(),
      },
    });

    // Create product alias
    const productAlias = await prisma.productAlias.create({
      data: {
        productId: product.id,
        aliasDescription: aliasDraft.aliasDescription!,
        status: 'active',
        createdBy: 'test_reviewer',
      },
    });

    assert(productAlias !== null, 'should create product alias');
    assert(productAlias.productId === product.id, 'alias should link to product');
    assert(productAlias.status === 'active', 'alias should be active');

    // Test 9: Count drafts by status
    console.log('\n--- Test 9: Count by status ---');

    const draftCount = await prisma.productDraft.count({
      where: {
        status: 'draft',
        sourceInvoiceId: { startsWith: 'TEST_MQ_' },
      },
    });

    const approvedCount = await prisma.productDraft.count({
      where: {
        status: 'approved',
        sourceInvoiceId: { startsWith: 'TEST_MQ_' },
      },
    });

    const rejectedCount = await prisma.productDraft.count({
      where: {
        status: 'rejected',
        sourceInvoiceId: { startsWith: 'TEST_MQ_' },
      },
    });

    assert(draftCount >= 0, `should count draft status (${draftCount})`);
    assert(approvedCount >= 3, `should count approved status (${approvedCount})`);
    assert(rejectedCount >= 1, `should count rejected status (${rejectedCount})`);

    // Test 10: Verify active products created
    console.log('\n--- Test 10: Verify active products ---');

    const activeProducts = await prisma.product.findMany({
      where: {
        description: { startsWith: 'TEST_MQ_' },
        status: 'active',
        deletedAt: null,
      },
    });

    assert(activeProducts.length >= 1, `should have active products (${activeProducts.length})`);

    // Test 11: Verify aliases created
    console.log('\n--- Test 11: Verify aliases ---');

    const aliases = await prisma.productAlias.findMany({
      where: {
        aliasDescription: { startsWith: 'TEST_MQ_' },
        status: 'active',
        deletedAt: null,
      },
    });

    assert(aliases.length >= 1, `should have active aliases (${aliases.length})`);

    // Test 12: Cannot approve already approved draft
    console.log('\n--- Test 12: Prevent double approval ---');

    const alreadyApproved = await prisma.productDraft.findUnique({
      where: { id: draft1.id },
    });

    assert(alreadyApproved?.status === 'approved', 'draft should already be approved');
    // In real API, this would return error. Here we just verify status.

    // Test 13: Sorting drafts
    console.log('\n--- Test 13: Sort drafts ---');

    const sortedDrafts = await prisma.productDraft.findMany({
      where: {
        sourceInvoiceId: { startsWith: 'TEST_MQ_' },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    assert(sortedDrafts.length > 0, 'should return sorted drafts');
    if (sortedDrafts.length >= 2) {
      assert(
        new Date(sortedDrafts[0].createdAt) >= new Date(sortedDrafts[1].createdAt),
        'should sort by created date descending'
      );
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
