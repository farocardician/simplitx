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
  const jobId = 'bf36e080-f181-4acd-91f2-875b47b5bbe1';

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      ownerSessionId: true,
      originalFilename: true,
      uploadPath: true,
      resultPath: true,
      mapping: true,
      status: true,
      buyerPartyId: true,
      buyerResolutionStatus: true,
      buyerResolutionConfidence: true,
      sha256: true,
      bytes: true,
      contentType: true
    }
  });

  if (!job) {
    console.log('Job not found');
    return;
  }

  console.log('\n=== CURRENT JOB ===');
  console.log(JSON.stringify(job, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

  let parserResult = await prisma.parserResult.findUnique({
    where: { docId: jobId },
    select: { final: true, docId: true }
  });

  if (!parserResult) {
    parserResult = await prisma.parserResult.findUnique({
      where: { docId: job.originalFilename },
      select: { final: true, docId: true }
    });
  }

  if (!parserResult) {
    parserResult = await prisma.parserResult.findUnique({
      where: { docId: `${jobId}.pdf` },
      select: { final: true, docId: true }
    });
  }

  if (!parserResult) {
    console.log('Parser result not found');
    return;
  }

  const buyerName = parserResult.final.buyer?.name || 'Unknown';
  console.log('\n=== BUYER NAME ===');
  console.log('Original:', buyerName);
  console.log('Normalized:', normalizePartyName(buyerName));

  const allParties = await prisma.party.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      displayName: true,
      nameNormalized: true,
      tinDisplay: true
    }
  });

  const normalized = normalizePartyName(buyerName);
  const scored = allParties.map(party => ({
    ...party,
    score: compareTwoStrings(normalized, party.nameNormalized)
  }));

  scored.sort((a, b) => b.score - a.score);

  console.log('\n=== TOP 10 MATCHES ===');
  scored.slice(0, 10).forEach((party, i) => {
    console.log(`${i + 1}. [${party.score.toFixed(4)}] ${party.displayName} (${party.tinDisplay})`);
  });

  console.log('\n=== SIMULATION DATA ===');
  const serializeJob = {
    ...job,
    bytes: job.bytes.toString()
  };

  console.log(JSON.stringify({
    jobData: serializeJob,
    buyerName: buyerName,
    parserResultDocId: parserResult.docId,
    topMatches: scored.slice(0, 5).map(p => ({
      id: p.id,
      name: p.displayName,
      score: p.score
    }))
  }, null, 2));

  await prisma.$disconnect();
}

main().catch(console.error);
