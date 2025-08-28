const { PrismaClient } = require('@prisma/client');
const { processJob } = require('./processor');
const { logger } = require('./logger');

const prisma = new PrismaClient();
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5000'); // 5 seconds
const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;

async function main() {
  logger.info(`Worker ${WORKER_ID} starting...`);
  
  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    await prisma.$disconnect();
    process.exit(0);
  });
  
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    await prisma.$disconnect();
    process.exit(0);
  });
  
  // Main processing loop
  while (true) {
    try {
      const job = await acquireJob();
      if (job) {
        await processJob(job);
      } else {
        await sleep(POLL_INTERVAL);
      }
    } catch (error) {
      logger.error('Worker loop error:', error);
      await sleep(POLL_INTERVAL);
    }
  }
}

async function acquireJob() {
  try {
    const result = await prisma.$queryRaw`
      UPDATE jobs
      SET 
        status = 'processing'::"job_status",
        leased_by = ${WORKER_ID},
        lease_expires_at = NOW() + INTERVAL '5 minutes',
        started_at = NOW(),
        updated_at = NOW()
      WHERE id IN (
        SELECT id FROM jobs
        WHERE status = 'queued'::"job_status"
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;
    
    return result[0] || null;
  } catch (error) {
    logger.error('Error acquiring job:', error);
    return null;
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Start the worker
main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});