# MVP Phase Plan (v2)

> High-level, code-free. Tweaked to: add `updated_at` + incremental polling early, use `SELECT … FOR UPDATE SKIP LOCKED` for picking, basic circuit breaker earlier, magic-byte validation, minimal structured logs sooner, and rate limiting in production scope.

## Phase 1: Foundation Layer
**Goal:** Establish data model and safe upload path

**Scope Now:**
- Prisma schema for `jobs` with: status enum, dedupe index `(owner_session_id, sha256, mapping, bytes)`, full timestamps, and **`updated_at`** (auto).
- Session cookie (`owner_session_id`).
- `POST /api/upload` with **PDF-only** validation (size ≤ 50MB) and **magic-byte** check (`%PDF`).
- Default **mapping** set (server allow-list; reject unknowns).
- Content-hash generation for dedupe.
- Save source PDF to `uploads/{jobId}.pdf`.
- Create job with `uploaded` → immediately `queued` (or `uploaded` if you defer dispatch by design).

**Scope Later:**
- `job_events` table, `job_artifacts` table.
- S3 storage.
- Auth users (beyond session cookie).

**Touchpoints:** DB (schema + indexes), API (`/api/upload`, session middleware), Storage (local `uploads/`).

**Test Plan:** Unit: PDF validation (MIME + magic bytes), hash, dedupe; Integration: upload valid/invalid/oversized; Manual: duplicate upload → dedupe.

**Exit Criteria:** Upload works end-to-end; job row created with correct fields; duplicate uploads reuse existing job; file saved under controlled path.

---

## Phase 2: Core Processing
**Goal:** Convert PDFs → XML via gateway reliably

**Scope Now:**
- **Worker service** container.
- **Job selection:** `UPDATE … SET status='processing' … WHERE status='queued' … FOR UPDATE SKIP LOCKED RETURNING *` (short transactions; do not hold locks during network calls).
- **Leases** only for reclaiming stuck `processing` (TTL + optional heartbeat), not for preventing double-pickup.
- Gateway client: `POST /process` with `Accept: application/xml`, `mapping`, file.
- Write XML to `results/{jobId}.xml`; mark `complete`.
- **Timeout** per call (e.g., 180s).
- **Graceful shutdown:** on SIGTERM, finish current job or cleanly release, refuse new work.
- **Circuit breaker (basic, hold-queue mode):** pause dispatch on elevated 5xx/timeout rate; resume when healthy.
- **Minimal structured logs** in web + worker (JSON: route/job_id/status/duration).

**Scope Later:**
- Mapping selection UI.

**Touchpoints:** Worker (Node), DB (status + timing fields), Gateway (internal URL), Storage (`results/`).

**Test Plan:** Unit: picker SQL path, gateway wrapper; Integration: end-to-end PDF→XML; Manual: kill worker mid-job → clean finish or release; gateway down → breaker holds queue.

**Exit Criteria:** Worker picks jobs without duplication; converts via gateway; correctly sets statuses; XML written; shutdown is graceful.

---

## Phase 3: User Interface
**Goal:** Users can see progress and download results

**Scope Now:**
- `GET /api/jobs` with **owner filtering** and optional `?since=<ISO>` using **`updated_at`**.
- Queue page (`/queue`) with polling every 3–5s, **stop when `active_count=0`**.
- `GET /api/jobs/:id/download` to stream XML.
- Basic badges: uploaded/queued, processing, complete, failed.
- **Ownership enforcement** on list/detail/download as an explicit exit criterion.

**Scope Later:**
- Filters/pagination; progress ETA; review placeholder route (`/review/:id`).

**Touchpoints:** API (`/api/jobs`, `/api/jobs/:id/download`), UI (queue page + polling).

**Test Plan:** Unit: polling + stop condition; Integration: ownership checks, download; Manual: multi-upload shows separate rows and updates live.

**Exit Criteria:** Queue shows only my jobs; polling updates live and halts when idle; completed jobs download; forbidden/expired paths handled cleanly.

---

## Phase 4: Reliability Layer
**Goal:** Fail well and recover automatically

**Scope Now:**
- Shared error taxonomy (`NOT_PDF`, `TOO_LARGE`, `GW_4XX`, `GW_5XX`, `GW_TIMEOUT`, `IO_ERROR`, `NOT_READY`, `EXPIRED`, `FORBIDDEN`).
- **Retry policy with jitter:** delay = `5s × 2^attempt + random(0–5s)`, max 3; retry on 5xx/timeout/IO only.
- Manual retry: `POST /api/jobs/:id/retry` (if source PDF exists).
- Clear error messages in UI for terminal failures.

**Scope Later:**
- Dead-letter tagging; breaker tuning.

**Touchpoints:** Worker (retry loop), API (retry endpoint), UI (error copy), DB (`attempt_count`, `last_attempt_at`, `error_*`).

**Test Plan:** Unit: backoff calc; Integration: gateway failures/timeouts; Manual: manual retry success path and capped attempts.

**Exit Criteria:** Transients auto-retry with spacing; terminal errors are clear; manual retry re-queues correctly; no retry storms.

---

## Phase 5: Production Ready
**Goal:** Secure, observable, and cost-aware

**Scope Now:**
- **Rate limiting**: uploads 10/min per session (429 with `Retry-After`).
- Mapping allow-list enforced across API and worker.
- Structured logs everywhere; basic metrics (queue depth, jobs by state, failures by code, gateway latency P95/P99).
- Retention: PDFs 7d, XML 30d (or delete on first download); daily cleanup safeguarding active jobs.
- Security headers, HTTPS, CORS locked; serve files only via download endpoint.
- UI polish (clear copy, badges, accessibility basics).

**Scope Later:**
- Redis cache for `/api/jobs` (2s TTL, invalidate on status change or `updated_at` bump); dashboards; S3 migration; advanced metrics.

**Touchpoints:** All services (logging/metrics), Worker (cleanup cron), API (validation + limits), UI (polish), DB (retention fields).

**Test Plan:** Unit: validation + cleanup; Integration: security paths + retention; Manual: accessibility; cache hit-rate experiment (if Redis enabled).

**Exit Criteria:** Unauthorized access blocked; old files cleaned; logs/metrics useful; friendly, accessible UI; limits active in prod.

---

## Implementation Notes

**Phase dependencies**
```
P1 (Foundation) → P2 (Processing) → P3 (UI)
                                  ↓
                            P4 (Reliability)
                                  ↓
                            P5 (Production)
```

**Critical path to MVP**
- Minimum shippable: **P1 + P2 + P3** (upload → process → download).
- Production minimum: **P1 + P2 + P3 + P4 + P5** (reliable, secure, observable).

**Risk mitigation**
- Additive DB migrations; feature flags for P4–P5; circuit breaker in P2 to avoid early overload; rollback by phase.

**Success metrics**
- **P1:** Upload success > 95%.
- **P2:** Processing success > 90%; **P95 job processing time** target (e.g., ≤ 30s typical).
- **P3:** Queue page load < 500ms; polling stops when idle.
- **P4:** Auto-retry success > 70%; failure rate **excluding 4xx** within budget.
- **P5:** Zero unauthorized access; cleanup runs daily; gateway 5xx rate < 1% sustained.

