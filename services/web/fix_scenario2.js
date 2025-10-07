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
  const targetNormalized = 'PT KERTAS NUSANTARA';

  // Test different buyer names to find one that gives score 0.86-0.92
  const testNames = [
    'PT KERTAS NUSANTARA TBK',
    'PT. KERTAS NUSANTARA.',
    'PT KERTAS NUSANTARA TBKK',
    'PT KERTAS NUSANTARAAA',
    'PT KERTAS NUSANTARA CO',
    'PT KERTASS NUSANTARA',
    'PT KERTAS NUSANTARAA',
    'PT KERTAS NUSANTRA'
  ];

  console.log('=== Testing Buyer Names for Score 0.86-0.92 ===\n');

  let bestMatch = null;
  let bestScore = 0;

  for (const name of testNames) {
    const normalized = normalizePartyName(name);
    const score = compareTwoStrings(normalized, targetNormalized);
    console.log(`"${name}" -> "${normalized}" -> Score: ${score.toFixed(4)}`);

    if (score >= 0.86 && score < 0.92) {
      if (!bestMatch || Math.abs(score - 0.89) < Math.abs(bestScore - 0.89)) {
        bestMatch = name;
        bestScore = score;
      }
    }
  }

  console.log('\n=== Best Match ===');
  if (bestMatch) {
    console.log(`Buyer Name: "${bestMatch}"`);
    console.log(`Score: ${bestScore.toFixed(4)}`);
    console.log('\nUpdating Scenario 2...');

    // Update scenario 2
    const jobId = '9218586a-72fd-481e-b64f-13984e790f3d';
    const docId = `${jobId}.pdf`;

    const parserResult = await prisma.parserResult.findUnique({
      where: { docId: docId }
    });

    if (parserResult) {
      const modifiedFinal = JSON.parse(JSON.stringify(parserResult.final));
      modifiedFinal.buyer.name = bestMatch;

      await prisma.parserResult.update({
        where: { docId: docId },
        data: {
          final: modifiedFinal,
          updatedAt: new Date()
        }
      });

      console.log(`✓ Updated parser result for ${jobId}`);
      console.log(`✓ New buyer name: "${bestMatch}"`);
      console.log(`✓ Expected score: ${bestScore.toFixed(4)}`);
      console.log(`✓ URL: http://localhost:3000/review/${jobId}`);
    }
  } else {
    console.log('No match found in range 0.86-0.92. Trying more options...');
  }

  await prisma.$disconnect();
}

main().catch(console.error);
