## Section A: Plan Summary

The system converts PDFs to XML via a gateway service, tracking each conversion as a Job with status updates:

- **Jobs table** is the single source of truth tracking uploaded PDFs through their lifecycle (uploaded→queued→processing→complete/failed)
- **Web API** provides upload, list, detail, download endpoints with session-based ownership
- **Worker service** picks queued jobs, calls gateway `/process` endpoint, saves XML results
- **Queue page** shows live status via polling with Review (placeholder) and Download actions
- **Storage** uses local disk initially (`uploads/`, `results/`) with S3 migration path, includes retention/cleanup
- **Mapping** defines XML output format (`pt_simon_invoice_v1` default), validated against allow-list
- **Security** enforces PDF-only, 50MB limit, session ownership, no direct file access
- **Observability** uses structured logs with job_id correlation, metrics for queue/gateway/storage
- **Failure handling** defines error taxonomy (GW_4XX, GW_5XX, IO_ERROR), retry policy, circuit breaker
- **Performance** controls via dedupe, concurrency limits, timeouts, circuit breaker
- **UI Polish** includes status badges, friendly error copy, accessibility, keyboard nav
- **Retention** auto-deletes PDFs after 7 days, XML after 30 days (configurable)

## Section B: Gaps & Resolutions

| Gap | Location | Resolution |
|-----|----------|------------|
| Worker service implementation unclear | c03_process.md | Use Node.js worker in separate container, share codebase with web |
| Queue mechanism not specified | c03_process.md | Use database polling initially (SELECT FOR UPDATE), add Redis queue later |
| Lease extension mechanism undefined | c01_jobs.md | Worker extends lease every 30s during processing via UPDATE |
| Circuit breaker implementation missing | c09_failure.md | Use in-memory sliding window (5min) with 50% failure threshold |
| Incremental polling `since` parameter optional | c02_api.md | Make it required for efficiency, track `updated_at` on jobs |
| Job events retention unclear | c01_jobs.md | Keep 90 days, then archive to cold storage |
| Dedupe scope inconsistent | Multiple docs | Use per-owner dedupe by default: `(owner_session_id, sha256, mapping, bytes)` |
| Worker count/scaling not defined | c03_process.md | Start with 1 worker container, scale horizontally via replicas |
| Gateway internal URL varies | Multiple docs | Standardize on `http://gateway:8000` internal, port 8002 public |
| Storage sharding trigger unclear | c05_storage.md | Switch to sharded paths at 10k files |

## Section C: Improvements

### 1. Add `updated_at` timestamp to jobs table
**Why:** Enables efficient incremental polling  
**Change:** Add `updated_at TIMESTAMPTZ DEFAULT NOW()` with trigger on UPDATE  
**Test:** Verify API returns only jobs modified since timestamp

### 2. Use SELECT FOR UPDATE SKIP LOCKED for job selection
**Why:** Prevents race conditions without complex locking  
**Change:** Replace lease-based selection with atomic PostgreSQL pattern  
**Test:** Run multiple workers, verify no duplicate processing

### 3. Add request rate limiting
**Why:** Prevent abuse and gateway overload  
**Change:** Add rate limit middleware: 10 uploads/min per session  
**Test:** Exceed limit, verify 429 response with retry-after header

### 4. Implement exponential backoff with jitter
**Why:** Prevents retry storms  
**Change:** Retry delays: 5s × 2^attempt + random(0-5s), max 3 attempts  
**Test:** Force failures, verify spacing increases

### 5. Add progress percentage estimation
**Why:** Better UX during processing  
**Change:** Track avg processing time by file size, show "~30s remaining"  
**Test:** Process various sizes, verify estimates within 50% accuracy

### 6. Implement graceful worker shutdown
**Why:** Prevents job corruption on deployment  
**Change:** SIGTERM handler completes current job, refuses new work  
**Test:** Kill worker mid-job, verify clean completion or release

### 7. Add content-type validation beyond extension
**Why:** Security - prevent malicious files  
**Change:** Check magic bytes (PDF starts with %PDF)  
**Test:** Upload renamed .txt as .pdf, verify rejection

### 8. Cache session jobs list in Redis
**Why:** Reduce DB load on frequent polling  
**Change:** Cache for 2s with invalidation on status change  
**Test:** Measure DB queries, should drop 80% during polling

## Section D: Phased Implementation

### Phase 1: Jobs Database & Upload API
**Goal:** Create jobs table, basic upload endpoint  
**Scope Now:** Schema, upload validation, job creation  
**Scope Later:** Worker processing, downloads  
**Touchpoints:** 
- DB: Create jobs, job_events tables with indices
- API: POST /api/upload, GET /api/jobs endpoints
- UI: Redirect to /queue after upload
**Test Plan:**
- Unit: Job creation, validation, dedupe logic
- Integration: Upload PDF, verify job created
- Manual: Upload various files, check DB state
**Exit Criteria:** Can upload PDF, creates job record, redirects to queue page

### Phase 2: Worker & Gateway Integration
**Goal:** Process PDFs through gateway  
**Scope Now:** Worker loop, gateway calls, status updates  
**Scope Later:** Retries, circuit breaker  
**Touchpoints:**
- Worker: Job selection, gateway client, result storage
- DB: Status transitions, lease management
- Storage: Write XML to results/
**Test Plan:**
- Unit: Lease acquisition, gateway client
- Integration: End-to-end PDF→XML
- Manual: Upload, watch status change
**Exit Criteria:** PDFs convert to XML successfully

### Phase 3: Queue Page & Downloads
**Goal:** Display job status, enable downloads  
**Scope Now:** Queue UI, polling, download endpoint  
**Scope Later:** Filters, pagination  
**Touchpoints:**
- UI: Queue page with status badges
- API: GET /api/jobs/:id/download
- Client: Polling logic with stop conditions
**Test Plan:**
- Unit: Polling stop logic
- Integration: Download complete jobs
- Manual: Multi-file upload, watch queue
**Exit Criteria:** Queue shows live status, can download XML

### Phase 4: Failure Handling & Retries
**Goal:** Handle errors gracefully  
**Scope Now:** Error taxonomy, retry policy  
**Scope Later:** Manual retry UI  
**Touchpoints:**
- Worker: Retry logic with backoff
- API: Error responses
- UI: Error message display
**Test Plan:**
- Unit: Retry backoff calculation
- Integration: Gateway timeout handling
- Manual: Force failures, verify recovery
**Exit Criteria:** Failures show clear messages, auto-retry works

### Phase 5: Storage & Retention
**Goal:** Implement cleanup and retention  
**Scope Now:** Daily cleanup job, expiry handling  
**Scope Later:** S3 migration  
**Touchpoints:**
- Worker: Cleanup cron job
- DB: Null paths on expiry
- API: 404 on expired downloads
**Test Plan:**
- Unit: Expiry date calculation
- Integration: Cleanup job execution
- Manual: Wait for expiry, verify deletion
**Exit Criteria:** Old files deleted, expired downloads return 404

### Phase 6: Security & Validation
**Goal:** Enforce all security controls  
**Scope Now:** Input validation, ownership checks  
**Scope Later:** Rate limiting  
**Touchpoints:**
- API: All endpoints validate ownership
- Worker: Mapping allow-list
- Storage: Path traversal prevention
**Test Plan:**
- Unit: Validation functions
- Integration: Ownership enforcement
- Manual: Try accessing others' jobs
**Exit Criteria:** Cannot access others' files, validation tight

### Phase 7: Observability
**Goal:** Add logging, metrics, dashboards  
**Scope Now:** Structured logs, basic metrics  
**Scope Later:** Full dashboards  
**Touchpoints:**
- All services: Structured JSON logs
- Metrics: Prometheus endpoints
- Alerts: Basic threshold alerts
**Test Plan:**
- Unit: Log format validation
- Integration: Metrics collection
- Manual: Trigger alerts
**Exit Criteria:** Can trace job through logs, metrics visible

### Phase 8: Performance & Circuit Breaker
**Goal:** Optimize performance, add resilience  
**Scope Now:** Circuit breaker, concurrency limits  
**Scope Later:** Redis queue  
**Touchpoints:**
- Worker: Circuit breaker logic
- API: Request rate limiting
- DB: Query optimization
**Test Plan:**
- Unit: Circuit breaker state machine
- Integration: Load testing
- Manual: Gateway failure simulation
**Exit Criteria:** System degrades gracefully under load

### Phase 9: UI Polish & Accessibility
**Goal:** Complete UI polish from c11_polish.md  
**Scope Now:** All UI improvements, microcopy  
**Scope Later:** Advanced features  
**Touchpoints:**
- UI: Status badges, error copy, keyboard nav
- API: Support incremental polling
- Copy: All user-facing messages
**Test Plan:**
- Unit: Component accessibility
- Integration: Keyboard navigation
- Manual: Screen reader testing
**Exit Criteria:** UI polished, accessible, clear messaging

## Section E: Testing Guidance

### Fixtures
```
valid.pdf     - 1MB normal PDF
invalid.txt   - Text file renamed .pdf  
oversized.pdf - 51MB PDF
corrupt.pdf   - Truncated PDF (invalid)
empty.pdf     - Valid PDF, 0 pages
```

### API Examples
```http
# Upload
POST /api/upload
Content-Type: multipart/form-data
--boundary
Content-Disposition: form-data; name="file"; filename="test.pdf"
Content-Type: application/pdf
[binary data]
--boundary--

Response: 200
{"job":{"id":"abc123","filename":"test.pdf","bytes":1024,"status":"uploaded","created_at":"2025-08-26T10:00:00Z"}}

# List jobs
GET /api/jobs?since=2025-08-26T09:00:00Z
Response: 200
{"jobs":[...],"active_count":2,"next_cursor":null}

# Download
GET /api/jobs/abc123/download
Response: 200 (streams XML)
409 (not ready)
404 (expired)
```

### Failure Scenarios
1. **Gateway timeout:** Set gateway latency to 200s, verify timeout at 180s
2. **Gateway 5xx:** Return 502 from gateway, verify retry with backoff
3. **Disk full:** Fill disk to 95%, verify IO_ERROR handling
4. **Worker crash:** Kill -9 worker mid-job, verify lease expiry and recovery
5. **Invalid mapping:** Send unknown mapping, verify GW_4XX error

### UX Acceptance
- Upload 5 PDFs simultaneously → 3 process, 2 queue
- Failed job shows "Converter is having an issue" not stack trace
- Tab+Enter navigates and activates Download button
- Download after expiry shows "File was removed by retention"
- Empty queue shows "No files yet. Drop PDFs here to convert"

## Section F: Concrete Specs

### Prisma Schema
```prisma
model Job {
  id              String    @id @default(uuid())
  ownerSessionId  String?   @map("owner_session_id")
  userId          String?   @map("user_id")
  
  originalFilename String   @map("original_filename")
  contentType     String    @default("application/pdf")
  bytes           BigInt
  sha256          String
  mapping         String    @default("pt_simon_invoice_v1")
  
  status          JobStatus
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
  
  events          JobEvent[]
  
  @@unique([ownerSessionId, sha256, mapping, bytes])
  @@index([status, createdAt])
  @@index([ownerSessionId, status])
  @@index([leaseExpiresAt])
}

enum JobStatus {
  uploaded
  queued
  processing
  complete
  failed
}

model JobEvent {
  id        String   @id @default(uuid())
  jobId     String   @map("job_id")
  job       Job      @relation(fields: [jobId], references: [id])
  eventType String   @map("event_type")
  meta      Json?
  createdAt DateTime @default(now()) @map("created_at")
  
  @@index([jobId, createdAt])
}
```

### REST Endpoints
```
POST   /api/upload           → Create job
GET    /api/jobs            → List jobs (owner-scoped)
GET    /api/jobs/:id        → Job detail
GET    /api/jobs/:id/download → Stream XML
POST   /api/jobs/:id/retry  → Retry failed job
GET    /api/healthz         → Health check
```

### Worker Job Selection SQL
```sql
UPDATE jobs 
SET status = 'processing',
    leased_by = $1,
    lease_expires_at = NOW() + INTERVAL '5 minutes',
    started_at = NOW(),
    attempt_count = attempt_count + 1
WHERE id IN (
  SELECT id FROM jobs 
  WHERE status = 'queued'
    AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

### UI Copy Strings
```javascript
const ERROR_MESSAGES = {
  NOT_PDF: "Only PDF files are supported",
  TOO_LARGE: "File exceeds 50 MB limit",
  GW_4XX: "Couldn't convert with this mapping",
  GW_5XX: "Converter is having an issue. We'll retry",
  GW_TIMEOUT: "Conversion is taking too long. We'll retry",
  IO_ERROR: "Temporary storage issue. We'll retry",
  EXPIRED: "File was removed by retention. Re-upload to regenerate",
  NOT_READY: "Conversion not finished yet",
  FORBIDDEN: "This file isn't yours"
};

const STATUS_LABELS = {
  uploaded: "Queued",
  queued: "Waiting",
  processing: "Converting...",
  complete: "Ready",
  failed: "Failed"
};
```

## Section G: Risks & Rollback

### Top Failure Modes

1. **Stuck Leases**
   - **Detect:** Jobs in processing > 10min
   - **Mitigate:** Reduce lease TTL, add heartbeat extension
   - **Rollback:** Manual lease clear, restart workers

2. **Retry Storm**
   - **Detect:** Retry rate > 50/min
   - **Mitigate:** Exponential backoff, circuit breaker
   - **Rollback:** Disable retries, manual intervention

3. **Gateway Flapping**
   - **Detect:** Health check oscillating
   - **Mitigate:** Circuit breaker with longer cooldown
   - **Rollback:** Route to backup gateway or pause

4. **Storage Exhaustion**
   - **Detect:** Disk > 90%
   - **Mitigate:** Aggressive cleanup, pause uploads
   - **Rollback:** Emergency S3 migration

5. **Polling Loops**
   - **Detect:** API requests > 1000/min from single session
   - **Mitigate:** Rate limit, force backoff
   - **Rollback:** Kill session, fix client

6. **Bad Mapping Rollout**
   - **Detect:** GW_4XX errors spike
   - **Mitigate:** Mapping allow-list, staged rollout
   - **Rollback:** Revert mapping registry

7. **Database Connection Pool Exhaustion**
   - **Detect:** Connection timeouts
   - **Mitigate:** Connection pooling, query optimization
   - **Rollback:** Scale DB, reduce worker count

### Rollback Plan by Phase
- **P1-P3:** Revert code, keep DB schema (additive only)
- **P4-P6:** Feature flags for new behavior
- **P7-P8:** Disable metrics collection if impacting performance
- **P9:** CSS-only changes, instant revert via CDN