const { PrismaClient } = require('@prisma/client');
const { compareTwoStrings } = require('string-similarity');

const prisma = new PrismaClient();

function normalizePartyName(displayName) {
  return displayName
    .trim()
    .toUpperCase()
    .replace(/[,.\'"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[-]+/g, '-')
    .trim();
}

async function main() {
  const jobIds = [
    { id: 'fdcf6c43-b02e-4398-a6d8-fb5babb06b2d', name: 'Scenario 1: Matched (auto)' },
    { id: '9218586a-72fd-481e-b64f-13984e790f3d', name: 'Scenario 2: Pending Confirmation' },
    { id: '863a4095-d6e2-46f3-b669-6b1ee25154cd', name: 'Scenario 3: Pending Selection' }
  ];

  // Get the target party
  const targetParty = await prisma.party.findFirst({
    where: {
      displayName: 'PT. KERTAS NUSANTARA',
      deletedAt: null
    },
    select: {
      id: true,
      displayName: true,
      nameNormalized: true,
      tinDisplay: true
    }
  });

  if (!targetParty) {
    console.log('Target party "PT. KERTAS NUSANTARA" not found');
    return;
  }

  console.log('=== TARGET PARTY ===');
  console.log(`Name: ${targetParty.displayName}`);
  console.log(`Normalized: ${targetParty.nameNormalized}`);
  console.log(`TIN: ${targetParty.tinDisplay}`);
  console.log('');

  for (const jobInfo of jobIds) {
    console.log(`\n=== ${jobInfo.name} ===`);
    console.log(`Job ID: ${jobInfo.id}`);

    const parserResult = await prisma.parserResult.findUnique({
      where: { docId: `${jobInfo.id}.pdf` },
      select: { final: true }
    });

    if (!parserResult) {
      console.log('Parser result not found');
      continue;
    }

    const buyerName = parserResult.final.buyer?.name || 'Unknown';
    const buyerNormalized = normalizePartyName(buyerName);
    const score = compareTwoStrings(buyerNormalized, targetParty.nameNormalized);

    console.log(`Buyer Name (Original): "${buyerName}"`);
    console.log(`Buyer Name (Normalized): "${buyerNormalized}"`);
    console.log(`Score vs "${targetParty.displayName}": ${score.toFixed(4)}`);

    // Determine expected resolution status
    if (score >= 0.92) {
      console.log(`Status: ✓ RESOLVED (auto-select, score ≥ 0.92)`);
    } else if (score >= 0.86) {
      console.log(`Status: ⚠ CANDIDATES (pending_confirmation, 0.86 ≤ score < 0.92)`);
    } else {
      console.log(`Status: ✗ UNRESOLVED (pending_selection, score < 0.86)`);
    }

    console.log(`URL: http://localhost:3000/review/${jobInfo.id}`);
  }

  await prisma.$disconnect();
}

main().catch(console.error);
