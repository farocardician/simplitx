const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('crypto');

const prisma = new PrismaClient();

async function main() {
  const originalJobId = 'bf36e080-f181-4acd-91f2-875b47b5bbe1';

  // Fetch original job
  const originalJob = await prisma.job.findUnique({
    where: { id: originalJobId }
  });

  if (!originalJob) {
    console.log('Original job not found');
    return;
  }

  // Fetch original parser result
  let originalParser = await prisma.parserResult.findUnique({
    where: { docId: originalJobId }
  });

  if (!originalParser) {
    originalParser = await prisma.parserResult.findUnique({
      where: { docId: `${originalJobId}.pdf` }
    });
  }

  if (!originalParser) {
    console.log('Parser result not found');
    return;
  }

  // Define three scenarios with different buyer names
  // These buyer names are designed to produce specific fuzzy match scores
  const scenarios = [
    {
      name: 'Scenario 1: Matched (auto, locked)',
      buyerName: 'PT KERTAS NUSANTARA', // Exact normalized match → score 1.0 (≥0.92)
      expectedScore: '1.00 (exact match)',
      expectedStatus: 'resolved → auto/locked'
    },
    {
      name: 'Scenario 2: Has candidates (pending_confirmation)',
      buyerName: 'PT. KERTAS NUSANTARA INDONESIA', // Medium match → score ~0.87-0.89 (0.86-0.92)
      expectedScore: '~0.87-0.89',
      expectedStatus: 'candidates → pending_confirmation'
    },
    {
      name: 'Scenario 3: Not matched/low score (pending_selection)',
      buyerName: 'PT. KERTAS NUSANTARA Menara Bidakara ', // Low match → score 0.6957 (<0.86)
      expectedScore: '0.6957',
      expectedStatus: 'unresolved → pending_selection'
    }
  ];

  const results = [];

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];
    const newJobId = randomUUID();
    const newParserDocId = `${newJobId}.pdf`;

    console.log(`\n=== Creating ${scenario.name} ===`);
    console.log(`Buyer Name: "${scenario.buyerName}"`);
    console.log(`Expected Score: ${scenario.expectedScore}`);
    console.log(`Expected Status: ${scenario.expectedStatus}`);

    // Create new job (duplicate original but with new ID)
    const newJob = await prisma.job.create({
      data: {
        id: newJobId,
        ownerSessionId: originalJob.ownerSessionId,
        userId: originalJob.userId,
        originalFilename: `simulation_${i + 1}_${originalJob.originalFilename}`,
        contentType: originalJob.contentType,
        bytes: originalJob.bytes,
        sha256: randomUUID(), // Use random UUID to avoid unique constraint
        mapping: originalJob.mapping,
        status: originalJob.status,
        uploadPath: originalJob.uploadPath,
        resultPath: originalJob.resultPath?.replace(originalJobId, newJobId),
        artifactPath: originalJob.artifactPath,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
        attemptCount: 0,
        approved: false,
        downloadCount: 0
      }
    });

    // Create new parser result with modified buyer name
    const modifiedFinal = JSON.parse(JSON.stringify(originalParser.final));
    if (modifiedFinal.buyer) {
      modifiedFinal.buyer.name = scenario.buyerName;
    } else {
      modifiedFinal.buyer = { name: scenario.buyerName };
    }

    const newParser = await prisma.parserResult.create({
      data: {
        docId: newParserDocId,
        final: modifiedFinal,
        manifest: originalParser.manifest,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    });

    const url = `http://localhost:3000/review/${newJobId}`;

    console.log(`✓ Job created: ${newJobId}`);
    console.log(`✓ Parser result created: ${newParserDocId}`);
    console.log(`✓ URL: ${url}`);

    results.push({
      scenario: scenario.name,
      jobId: newJobId,
      buyerName: scenario.buyerName,
      expectedScore: scenario.expectedScore,
      expectedStatus: scenario.expectedStatus,
      url: url
    });
  }

  console.log('\n\n=== SIMULATION SUMMARY ===\n');
  results.forEach((result, i) => {
    console.log(`${i + 1}. ${result.scenario}`);
    console.log(`   Buyer Name: "${result.buyerName}"`);
    console.log(`   Expected Score: ${result.expectedScore}`);
    console.log(`   Expected Status: ${result.expectedStatus}`);
    console.log(`   Job ID: ${result.jobId}`);
    console.log(`   URL: ${result.url}`);
    console.log('');
  });

  await prisma.$disconnect();
}

main().catch(console.error);
