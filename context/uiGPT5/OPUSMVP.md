# MVP Phase Plan

## Phase 1: Foundation Layer
**Goal:** Establish data model and basic upload capability

**Scope Now:**
- Prisma schema for `jobs` table with all fields
- Session management (owner_session_id cookie)
- POST /api/upload endpoint with PDF validation
- File storage to `uploads/` directory
- Content hash generation for dedupe
- Basic job creation with `uploaded` status

**Scope Later:**
- job_events table
- User authentication
- S3 storage

**Touchpoints:**
- DB: Create jobs table with indices
- API: POST /api/upload, session middleware
- Storage: Local uploads/ directory
- UI: Minimal changes to existing upload form

**Test Plan:**
- Unit: PDF validation, hash generation, dedupe logic
- Integration: Upload various files (valid PDF, invalid types, oversized)
- Manual: Upload same file twice, verify dedupe

**Exit Criteria:**
- Can upload PDF via existing form
- Job record created with correct metadata
- Duplicate uploads detected via hash
- Files saved to uploads/{jobId}.pdf

---

## Phase 2: Core Processing
**Goal:** Process PDFs through gateway to XML

**Scope Now:**
- Worker service container
- Database polling for job selection
- Gateway client for PDF→XML conversion
- Status transitions (queued→processing→complete/failed)
- Basic lease management
- XML storage to results/ directory

**Scope Later:**
- Redis queue
- Circuit breaker
- Retry logic
- Mapping selection

**Touchpoints:**
- Worker: New Node.js service
- DB: Status updates, lease fields
- Gateway: Call to :8000/process endpoint
- Storage: Write to results/ directory

**Test Plan:**
- Unit: Lease acquisition, gateway client wrapper
- Integration: End-to-end PDF→XML conversion
- Manual: Upload PDF, verify XML generation

**Exit Criteria:**
- Worker picks up queued jobs
- Gateway converts PDF to XML successfully
- Status transitions work correctly
- XML files saved to results/{jobId}.xml

---

## Phase 3: User Interface
**Goal:** Display job status and enable downloads

**Scope Now:**
- GET /api/jobs endpoint with owner filtering
- Queue page with live status display
- Polling with stop conditions (active_count=0)
- GET /api/jobs/:id/download endpoint
- Basic status badges (uploaded, processing, complete)

**Scope Later:**
- Filters and pagination
- Review functionality
- Advanced UI polish

**Touchpoints:**
- API: GET /api/jobs, GET /api/jobs/:id/download
- UI: New /queue page with polling
- Client: Status polling logic

**Test Plan:**
- Unit: Polling logic, stop conditions
- Integration: Download complete jobs, ownership verification
- Manual: Multi-file upload, watch status updates

**Exit Criteria:**
- Queue page shows all user's jobs
- Status updates visible via polling
- Can download completed XML files
- Polling stops when no active jobs

---

## Phase 4: Reliability Layer
**Goal:** Handle failures gracefully with retries

**Scope Now:**
- Error taxonomy implementation (GW_4XX, GW_5XX, etc.)
- Retry policy with exponential backoff
- Timeout handling (180s default)
- Failed status with error messages
- Basic circuit breaker (hold-queue mode)
- Manual retry endpoint

**Scope Later:**
- Dead letter queue
- Advanced circuit breaker modes
- Retry storm prevention

**Touchpoints:**
- Worker: Retry logic, timeout handling
- API: POST /api/jobs/:id/retry endpoint
- UI: Display error messages
- DB: attempt_count, error fields

**Test Plan:**
- Unit: Backoff calculation, circuit breaker state
- Integration: Gateway failure handling
- Manual: Force various failure modes

**Exit Criteria:**
- Transient failures retry automatically
- Clear error messages for permanent failures
- Circuit breaker prevents cascade failures
- Manual retry works for failed jobs

---

## Phase 5: Production Ready
**Goal:** Security, observability, and polish for production

**Scope Now:**
- Ownership enforcement on all endpoints
- Mapping allow-list validation
- Structured JSON logging with job_id
- Basic metrics (queue depth, success rate)
- Retention policy (7 days PDF, 30 days XML)
- Daily cleanup job
- UI polish from c11_polish.md (status badges, copy, accessibility)

**Scope Later:**
- Rate limiting
- Full dashboards
- S3 migration
- Advanced metrics

**Touchpoints:**
- All services: Add structured logging
- Worker: Cleanup cron job
- API: Security validation on all endpoints
- UI: Polish per c11_polish.md
- DB: Retention fields

**Test Plan:**
- Unit: Validation functions, cleanup logic
- Integration: Security tests, retention cleanup
- Manual: Accessibility testing, expiry handling

**Exit Criteria:**
- Cannot access other users' jobs
- Old files cleaned up automatically
- Logs traceable via job_id
- UI polished with clear messaging
- Basic metrics available

---

## Implementation Notes

### Phase Dependencies
```
P1 (Foundation) → P2 (Processing) → P3 (UI)
                                  ↓
                            P4 (Reliability)
                                  ↓
                            P5 (Production)
```

### Token Budget Per Phase
- **P1:** ~15K tokens (schema, upload API, validation)
- **P2:** ~20K tokens (worker service, gateway integration)
- **P3:** ~15K tokens (queue page, polling, download)
- **P4:** ~10K tokens (error handling, retries)
- **P5:** ~15K tokens (security, logging, polish)

### Critical Path to MVP
**Minimum shippable:** P1 + P2 + P3 (users can upload, process, download)
**Production minimum:** P1 + P2 + P3 + P4 + P5 (reliable, secure, observable)

### Risk Mitigation
- Each phase can be rolled back independently
- Database migrations are additive only
- Feature flags for new behavior in P4-P5
- Keep existing upload flow working throughout

### Success Metrics
- **P1:** Upload success rate > 95%
- **P2:** Processing success rate > 90%
- **P3:** Queue page load time < 500ms
- **P4:** Auto-retry success rate > 70%
- **P5:** Zero unauthorized access, cleanup runs daily