# Phase 2: Core Processing - Detailed Implementation Plan

## 1. Goal
Implement background worker service to process queued PDFs through the existing gateway, converting them to XML and updating job status throughout the lifecycle.

## 2. Scope

### Now (Phase 2)
- **Worker Service**: Standalone Node.js service for background processing
- **Database Polling**: SELECT FOR UPDATE SKIP LOCKED pattern for job acquisition
- **Gateway Integration**: HTTP client to call gateway's `/process` endpoint
- **Status Transitions**: queued→processing→complete/failed with proper timestamps
- **Lease Management**: Basic lease acquisition and release
- **Result Storage**: Save XML to `results/{jobId}.xml` directory
- **Basic Error Handling**: Capture gateway errors, mark jobs failed
- **Docker Setup**: Worker container with shared volumes

### Later (Deferred)
- Retry logic with exponential backoff (Phase 4)
- Circuit breaker for gateway failures (Phase 4)
- Concurrent processing limits (Phase 4)
- Job events tracking (Phase 5)
- Mapping selection UI (Phase 3)
- S3 storage (Phase 5)
- Redis queue (Future)

## 3. Touchpoints

### Database
```
- Status transitions (queued→processing→complete/failed)
- Lease management fields (leasedBy, leaseExpiresAt)
- Result path storage
- Error tracking (errorCode, errorMessage)
```

### Worker Service
```
- New standalone Node.js service
- Database connection via Prisma
- HTTP client for gateway communication
- File I/O for results
```

### Gateway
```
- POST to http://gateway:8000/process
- Accept: application/xml header
- Mapping parameter handling
```

### Storage
```
- Create results/ directory structure
- Write XML files as {jobId}.xml
- Shared volume with web service
```

## 4. Implementation Tasks

### 4.1 Worker Service Structure
```typescript
// services/worker/src/index.ts
import { PrismaClient } from '@prisma/client';
import { processJob } from './processor';
import { logger } from './logger';

const prisma = new PrismaClient();
const POLL_INTERVAL = 5000; // 5 seconds
const WORKER_ID = `worker-${process.pid}`;

async function main() {
  logger.info(`Worker ${WORKER_ID} starting...`);
  
  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
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
  return await prisma.$transaction(async (tx) => {
    const job = await tx.$queryRaw`
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
    
    return job[0] || null;
  });
}
```

### 4.2 Job Processor
```typescript
// services/worker/src/processor.ts
import axios from 'axios';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Job } from '@prisma/client';
import FormData from 'form-data';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://gateway:8000';
const GATEWAY_TIMEOUT = parseInt(process.env.GATEWAY_TIMEOUT || '180000');

export async function processJob(job: Job) {
  logger.info(`Processing job ${job.id}`);
  
  try {
    // Read PDF file
    const pdfPath = job.uploadPath;
    if (!pdfPath) {
      throw new Error('No upload path specified');
    }
    
    // Call gateway
    const xmlContent = await callGateway(pdfPath, job.mapping);
    
    // Save XML result
    const resultPath = `results/${job.id}.xml`;
    await saveResult(resultPath, xmlContent);
    
    // Update job as complete
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'complete',
        resultPath,
        completedAt: new Date(),
        leasedBy: null,
        leaseExpiresAt: null
      }
    });
    
    logger.info(`Job ${job.id} completed successfully`);
    
  } catch (error) {
    await handleJobError(job, error);
  }
}

async function callGateway(pdfPath: string, mapping: string): Promise<string> {
  const form = new FormData();
  form.append('file', createReadStream(pdfPath), {
    filename: 'document.pdf',
    contentType: 'application/pdf'
  });
  form.append('mapping', `${mapping}.json`);
  form.append('pretty', '1');
  
  const response = await axios.post(`${GATEWAY_URL}/process`, form, {
    headers: {
      ...form.getHeaders(),
      'Accept': 'application/xml'
    },
    timeout: GATEWAY_TIMEOUT,
    maxContentLength: 100 * 1024 * 1024, // 100MB
    validateStatus: null // Handle all status codes
  });
  
  if (response.status === 200) {
    return response.data;
  }
  
  // Map gateway errors to our error codes
  const errorMap: Record<number, { code: string, message: string }> = {
    400: { code: 'GW_4XX', message: 'Invalid request to gateway' },
    406: { code: 'GW_4XX', message: 'Unsupported file type or mapping' },
    413: { code: 'TOO_LARGE', message: 'File exceeds gateway limit' },
    415: { code: 'GW_4XX', message: 'Unsupported media type' },
    502: { code: 'GW_5XX', message: 'Gateway processing error' }
  };
  
  const error = errorMap[response.status] || {
    code: 'GW_5XX',
    message: `Gateway returned status ${response.status}`
  };
  
  throw new GatewayError(error.code, error.message, response.status);
}

async function saveResult(path: string, content: string) {
  const tempPath = `${path}.tmp`;
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, path); // Atomic write
}

async function handleJobError(job: Job, error: any) {
  logger.error(`Job ${job.id} failed:`, error);
  
  let errorCode = 'UNKNOWN';
  let errorMessage = 'An unexpected error occurred';
  
  if (error instanceof GatewayError) {
    errorCode = error.code;
    errorMessage = error.message;
  } else if (error.code === 'ECONNREFUSED') {
    errorCode = 'GW_5XX';
    errorMessage = 'Gateway service unavailable';
  } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
    errorCode = 'GW_TIMEOUT';
    errorMessage = 'Gateway request timed out';
  } else if (error.code === 'ENOSPC') {
    errorCode = 'IO_ERROR';
    errorMessage = 'Insufficient storage space';
  }
  
  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: 'failed',
      errorCode,
      errorMessage,
      failedAt: new Date(),
      leasedBy: null,
      leaseExpiresAt: null
    }
  });
}
```

### 4.3 Docker Configuration
```yaml
# docker-compose.yml
services:
  worker:
    build: ./services/worker
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/pdf_jobs
      GATEWAY_URL: http://gateway:8000
      NODE_ENV: development
      WORKER_CONCURRENCY: 1
      GATEWAY_TIMEOUT: 180000
    volumes:
      - ./uploads:/app/uploads
      - ./results:/app/results
    depends_on:
      postgres:
        condition: service_healthy
      gateway:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - pdf-network

# Worker Dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
CMD ["node", "src/index.js"]
```

### 4.4 Worker Package Configuration
```json
// services/worker/package.json
{
  "name": "pdf-worker",
  "version": "1.0.0",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "dev": "nodemon src/index.js",
    "build": "tsc",
    "test": "jest"
  },
  "dependencies": {
    "@prisma/client": "^5.0.0",
    "axios": "^1.6.0",
    "form-data": "^4.0.0",
    "winston": "^3.11.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "jest": "^29.0.0",
    "nodemon": "^3.0.0",
    "typescript": "^5.0.0"
  }
}
```

### 4.5 Shared Prisma Schema Updates
```typescript
// Ensure worker can access same Prisma schema
// Copy schema.prisma to worker service or use shared package
```

## 5. Test Plan

### 5.1 Unit Tests
```typescript
// __tests__/processor.test.ts
describe('Job Processor', () => {
  test('Successfully processes PDF to XML', async () => {
    // Mock gateway response
    // Verify XML saved to correct path
    // Check job status updated to complete
  });
  
  test('Handles gateway 4xx errors', async () => {
    // Mock 406 response
    // Verify job marked failed with GW_4XX
  });
  
  test('Handles gateway timeout', async () => {
    // Mock timeout
    // Verify job marked failed with GW_TIMEOUT
  });
});

// __tests__/acquire.test.ts
describe('Job Acquisition', () => {
  test('Acquires oldest queued job', async () => {
    // Create multiple queued jobs
    // Verify oldest selected
  });
  
  test('Skips locked jobs', async () => {
    // Create locked job
    // Verify skipped
  });
  
  test('Handles lease expiry', async () => {
    // Create expired lease
    // Verify job re-acquired
  });
});
```

### 5.2 Integration Tests
```typescript
// __tests__/integration/end-to-end.test.ts
describe('End-to-End Processing', () => {
  test('Complete flow: upload → queue → process → complete', async () => {
    // Upload PDF via API
    // Wait for worker to process
    // Verify XML file created
    // Check job status complete
  });
  
  test('Gateway unavailable handling', async () => {
    // Stop gateway container
    // Upload PDF
    // Verify job marked failed
    // Check error code GW_5XX
  });
});
```

### 5.3 Manual Test Checklist
- [ ] Upload PDF → job status changes to queued
- [ ] Worker picks up job → status changes to processing
- [ ] Gateway processes successfully → XML saved to results/
- [ ] Job marked complete with resultPath
- [ ] Upload large PDF (40MB) → processes successfully
- [ ] Stop gateway → job fails with GW_5XX
- [ ] Kill worker mid-process → lease expires, job re-processed
- [ ] Multiple uploads → processed in order (FIFO)
- [ ] Check logs → correlation with job IDs
- [ ] Verify atomic XML write (no partial files)

## 6. Exit Criteria

### Functional Requirements Met
- [x] Worker service implemented and dockerized
- [x] Database polling with SELECT FOR UPDATE SKIP LOCKED
- [x] Gateway integration via HTTP client
- [x] Status transitions working (queued→processing→complete/failed)
- [x] Lease management prevents duplicate processing
- [x] XML results saved to results/{jobId}.xml
- [x] Error handling with proper error codes
- [x] Graceful shutdown on SIGTERM

### Quality Metrics
- [ ] All unit tests passing (>80% coverage)
- [ ] Integration tests verify end-to-end flow
- [ ] Manual testing checklist complete
- [ ] No race conditions in job acquisition
- [ ] No zombie jobs (stuck in processing)

### Performance Baseline
- [ ] Job acquisition < 100ms
- [ ] Gateway call + processing < 30s for typical invoice
- [ ] Can process 510 line items (verified in PROJECT_SUMMARY)
- [ ] Memory usage < 256MB per worker

### Documentation
- [ ] Worker architecture documented
- [ ] Environment variables documented
- [ ] Docker setup instructions
- [ ] Troubleshooting guide

## 7. Dependencies & Configuration

### Environment Variables
```env
# Worker environment
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/pdf_jobs
GATEWAY_URL=http://gateway:8000
WORKER_ID=worker-1
POLL_INTERVAL=5000
LEASE_TTL_MINUTES=5
GATEWAY_TIMEOUT=180000
LOG_LEVEL=info
```

### Directory Structure
```
project/
├── services/
│   ├── web/          # Existing from Phase 1
│   └── worker/       # New in Phase 2
│       ├── src/
│       │   ├── index.ts
│       │   ├── processor.ts
│       │   ├── logger.ts
│       │   └── errors.ts
│       ├── Dockerfile
│       ├── package.json
│       └── tsconfig.json
├── uploads/          # Shared volume
├── results/          # New - shared volume
└── docker-compose.yml
```

### Startup Commands
```bash
# Create results directory
mkdir -p results

# Start all services
docker-compose up -d postgres
docker-compose up -d gateway pdf2json json2xml
docker-compose up -d worker

# View worker logs
docker-compose logs -f worker

# Test processing
curl -X POST http://localhost:3000/api/upload \
  -F "file=@test.pdf"
```

## Success Indicators
- Jobs automatically progress from upload to completion
- Gateway integration working with proper error handling
- Worker resilient to failures (gateway down, crashes)
- Clear separation of concerns (web handles uploads, worker handles processing)
- Foundation ready for Phase 3 (UI) and Phase 4 (reliability)