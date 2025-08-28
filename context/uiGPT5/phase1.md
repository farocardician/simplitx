# Phase 1: Foundation Layer - Detailed Implementation Plan

## 1. Goal
Establish the core data model and transform the existing upload system into a job-tracked workflow, creating a persistent record for each PDF upload with ownership, deduplication, and metadata tracking.

## 2. Scope

### Now (Phase 1)
- **Database Setup**: PostgreSQL with Prisma ORM, jobs table with comprehensive schema
- **Session Management**: owner_session_id cookie for anonymous user tracking
- **Enhanced Upload API**: Extend existing `/api/upload` to create job records
- **Deduplication**: SHA-256 hash-based duplicate detection per session
- **File Storage**: Maintain existing uploads/ directory with jobId-based naming
- **Basic Job API**: GET /api/jobs endpoint for listing user's jobs
- **Minimal UI Changes**: Redirect to /queue route after upload success

### Later (Deferred)
- job_events table (Phase 5)
- Worker processing (Phase 2)
- XML generation (Phase 2)
- Queue page UI (Phase 3)
- Downloads (Phase 3)
- Retry mechanisms (Phase 4)
- S3 storage (Phase 5)
- User authentication (Future)

## 3. Touchpoints

### Database
```
- New PostgreSQL database setup
- Prisma schema with jobs table
- Indices for efficient querying
- Migration scripts
```

### API Layer
```
- Enhance POST /api/upload (add job creation)
- New GET /api/jobs (list jobs)
- New session middleware (owner tracking)
```

### Storage
```
- Rename uploaded files to {jobId}.pdf
- Maintain uploads/ directory structure
- Add SHA-256 hash computation
```

### UI
```
- Add redirect to /queue after upload
- Create placeholder /queue route
```

## 4. Implementation Tasks

### 4.1 Database Setup
```typescript
// prisma/schema.prisma
model Job {
  id              String    @id @default(uuid())
  ownerSessionId  String?   @map("owner_session_id")
  userId          String?   @map("user_id")
  
  originalFilename String   @map("original_filename")
  contentType     String    @default("application/pdf") @map("content_type")
  bytes           BigInt
  sha256          String    @db.Char(64)
  mapping         String    @default("pt_simon_invoice_v1")
  
  status          JobStatus @default(uploaded)
  uploadPath      String?   @map("upload_path")
  resultPath      String?   @map("result_path")
  errorCode       String?   @map("error_code")
  errorMessage    String?   @map("error_message")
  
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")
  queuedAt        DateTime? @map("queued_at")
  startedAt       DateTime? @map("started_at")
  completedAt     DateTime? @map("completed_at")
  failedAt        DateTime? @map("failed_at")
  
  leasedBy        String?   @map("leased_by")
  leaseExpiresAt  DateTime? @map("lease_expires_at")
  attemptCount    Int       @default(0) @map("attempt_count")
  
  expiresAt       DateTime? @map("expires_at")
  downloadCount   Int       @default(0) @map("download_count")
  firstDownloadAt DateTime? @map("first_downloaded_at")
  
  @@unique([ownerSessionId, sha256, mapping, bytes])
  @@index([status, createdAt(sort: Desc)])
  @@index([ownerSessionId, status])
  @@index([ownerSessionId, createdAt(sort: Desc)])
  @@index([leaseExpiresAt])
  @@map("jobs")
}

enum JobStatus {
  uploaded
  queued
  processing
  complete
  failed
  @@map("job_status")
}
```

### 4.2 Session Middleware
```typescript
// lib/session.ts
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

export function withSession(handler: Function) {
  return async (req: NextRequest, ...args: any[]) => {
    const sessionId = req.cookies.get('owner_session_id')?.value || randomUUID();
    
    const response = await handler(req, { sessionId }, ...args);
    
    if (!req.cookies.has('owner_session_id')) {
      response.cookies.set('owner_session_id', sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30 // 30 days
      });
    }
    
    return response;
  };
}
```

### 4.3 Enhanced Upload API
```typescript
// app/api/upload/route.ts
import { createHash } from 'crypto';
import { prisma } from '@/lib/prisma';
import { withSession } from '@/lib/session';

async function uploadHandler(req: NextRequest, { sessionId }: { sessionId: string }) {
  const formData = await req.formData();
  const file = formData.get('file') as File;
  
  // Validation
  if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
    return NextResponse.json(
      { error: { code: 'NOT_PDF', message: 'Only PDF files are supported' } },
      { status: 400 }
    );
  }
  
  if (file.size > 50 * 1024 * 1024) {
    return NextResponse.json(
      { error: { code: 'TOO_LARGE', message: 'File exceeds 50 MB limit' } },
      { status: 413 }
    );
  }
  
  // Compute hash
  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  
  // Check for duplicates
  const existing = await prisma.job.findFirst({
    where: {
      ownerSessionId: sessionId,
      sha256,
      mapping: 'pt_simon_invoice_v1',
      bytes: BigInt(file.size)
    }
  });
  
  if (existing) {
    return NextResponse.json({
      job: existing,
      deduped_from: existing.id
    });
  }
  
  // Create job
  const job = await prisma.job.create({
    data: {
      ownerSessionId: sessionId,
      originalFilename: file.name,
      contentType: file.type || 'application/pdf',
      bytes: BigInt(file.size),
      sha256,
      mapping: 'pt_simon_invoice_v1',
      status: 'uploaded',
      uploadPath: null // Will be set after file write
    }
  });
  
  // Save file
  const uploadPath = `uploads/${job.id}.pdf`;
  await writeFile(uploadPath, buffer);
  
  // Update job with path
  await prisma.job.update({
    where: { id: job.id },
    data: { 
      uploadPath,
      status: 'queued',
      queuedAt: new Date()
    }
  });
  
  return NextResponse.json({ 
    job: {
      id: job.id,
      filename: job.originalFilename,
      bytes: Number(job.bytes),
      status: job.status,
      created_at: job.createdAt.toISOString()
    }
  });
}

export const POST = withSession(uploadHandler);
```

### 4.4 Jobs List API
```typescript
// app/api/jobs/route.ts
export const GET = withSession(async (req: NextRequest, { sessionId }: { sessionId: string }) => {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
  const since = searchParams.get('since');
  
  const where: any = { ownerSessionId: sessionId };
  
  if (status) {
    where.status = status;
  }
  
  if (since) {
    where.updatedAt = { gte: new Date(since) };
  }
  
  const jobs = await prisma.job.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit
  });
  
  const activeCount = await prisma.job.count({
    where: {
      ownerSessionId: sessionId,
      status: { in: ['uploaded', 'queued', 'processing'] }
    }
  });
  
  return NextResponse.json({
    jobs: jobs.map(job => ({
      id: job.id,
      filename: job.originalFilename,
      bytes: Number(job.bytes),
      status: job.status,
      created_at: job.createdAt.toISOString(),
      completed_at: job.completedAt?.toISOString() || null,
      error: job.errorMessage,
      can_download: job.status === 'complete'
    })),
    active_count: activeCount,
    next_cursor: null
  });
});
```

### 4.5 Queue Page Placeholder
```typescript
// app/queue/page.tsx
export default function QueuePage() {
  return (
    <div className="container mx-auto p-8">
      <h1 className="text-2xl font-bold mb-4">Processing Queue</h1>
      <p>Your files will appear here. Processing functionality coming in Phase 2.</p>
    </div>
  );
}
```

## 5. Test Plan

### 5.1 Unit Tests
```typescript
// __tests__/lib/hash.test.ts
- Test SHA-256 hash generation for various file sizes
- Test hash consistency for identical files
- Test different hashes for different files

// __tests__/lib/session.test.ts
- Test session ID generation
- Test cookie setting/reading
- Test session persistence

// __tests__/api/upload.test.ts
- Test PDF validation (valid, invalid types, oversized)
- Test job creation with correct metadata
- Test deduplication logic
```

### 5.2 Integration Tests
```typescript
// __tests__/integration/upload-flow.test.ts
describe('Upload Flow', () => {
  test('Upload creates job and redirects', async () => {
    // Upload valid PDF
    // Verify job in database
    // Check file saved with jobId name
    // Verify redirect response
  });
  
  test('Duplicate upload returns existing job', async () => {
    // Upload PDF twice
    // Verify same job returned
    // Check deduped_from field
  });
  
  test('Different sessions create separate jobs', async () => {
    // Upload same file with different sessions
    // Verify two jobs created
  });
});
```

### 5.3 Manual Test Checklist
- [ ] Upload valid 1MB PDF → job created, file saved as {jobId}.pdf
- [ ] Upload same PDF again → returns existing job with deduped_from
- [ ] Upload 51MB file → rejected with TOO_LARGE error
- [ ] Upload .txt file → rejected with NOT_PDF error
- [ ] Upload without session → new session created and persisted
- [ ] GET /api/jobs → returns user's jobs only
- [ ] Different browser → different session, separate jobs
- [ ] Check database → all fields populated correctly
- [ ] Check uploads/ → files named by jobId

## 6. Exit Criteria

### Functional Requirements Met
- [x] PostgreSQL database configured with Prisma
- [x] Jobs table created with all specified fields
- [x] Session management via httpOnly cookies
- [x] Enhanced upload API creates job records
- [x] SHA-256 deduplication working per session
- [x] Files saved as uploads/{jobId}.pdf
- [x] GET /api/jobs returns session-scoped jobs
- [x] Redirect to /queue after upload

### Quality Metrics
- [ ] All unit tests passing (>90% coverage)
- [ ] Integration tests verify end-to-end flow
- [ ] Manual testing checklist complete
- [ ] No SQL injection vulnerabilities
- [ ] No path traversal vulnerabilities
- [ ] Session cookies secure in production

### Documentation
- [ ] Database schema documented
- [ ] API endpoints documented with examples
- [ ] Setup instructions for local development
- [ ] Migration instructions included

### Performance Baseline
- [ ] Upload response < 500ms for 5MB files
- [ ] Jobs list query < 100ms for 100 records
- [ ] Deduplication check < 50ms

## 7. Dependencies & Setup

### Required Services
```yaml
# docker-compose.yml addition
postgres:
  image: postgres:15-alpine
  environment:
    POSTGRES_DB: pdf_jobs
    POSTGRES_USER: postgres
    POSTGRES_PASSWORD: postgres
  ports:
    - "5432:5432"
  volumes:
    - postgres_data:/var/lib/postgresql/data
```

### Environment Variables
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/pdf_jobs"
NODE_ENV="development"
```

### NPM Dependencies
```json
{
  "dependencies": {
    "@prisma/client": "^5.0.0",
    "prisma": "^5.0.0"
  }
}
```

### Setup Commands
```bash
# Install dependencies
npm install @prisma/client prisma

# Initialize Prisma
npx prisma init

# Run migrations
npx prisma migrate dev --name init

# Generate Prisma client
npx prisma generate
```

## Success Indicators
- Existing upload functionality enhanced without breaking changes
- Clear separation between Phase 1 foundation and future phases
- Database ready for worker processing (Phase 2)
- API contracts defined for UI integration (Phase 3)
- Security and validation in place from day one