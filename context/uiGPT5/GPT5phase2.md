
# Phase 2 — Core Processing (v2)

> High-level, code-free. This patches Phase 2 to: reclaim stuck jobs, use SKIP LOCKED cleanly, finish jobs on shutdown, align paths/env, map all error cases, add a basic circuit breaker, validate mappings in the worker, and add minimal structured logs.

## Goal
Convert queued jobs (PDFs) into XML via the Gateway reliably and safely, without double-processing or getting stuck.

---

## Scope (Now)

### Worker service
- Runs as a separate container/process.
- Shares the same Postgres as web (same DB name as Phase 1, e.g., `convert_jobs_dev`).

### Job lifecycle in the worker
1) **Reclaim (stuck `processing`)**
   - Periodically (or at the start of each loop), requeue jobs whose lease expired:
     - `status='processing' AND lease_expires_at < NOW()` → set `status='queued'`, clear `leased_by` and `lease_expires_at`, bump `updated_at`.
   - Leases exist **only** to reclaim stuck `processing` jobs (not for pick-up).

2) **Claim (from `queued`)**
   - Use **`SELECT … FOR UPDATE SKIP LOCKED`** to atomically pick the oldest queued job(s).
   - Do **not** filter queued jobs by lease fields (leases don’t apply to queued rows).
   - In a short transaction, set `status='processing'`, `leased_by`, `lease_expires_at=NOW()+TTL`, `started_at=COALESCE(started_at, NOW())`, bump `updated_at`.
   - Never hold DB locks while calling the Gateway.

3) **Process**
   - Validate `mapping` against the server allow-list (fail fast if unknown).
   - Read the PDF from `UPLOADS_DIR/{jobId}.pdf`.
   - Call the Gateway `POST /process` with `Accept: application/xml`, `mapping`, and the file.
   - Timeout: e.g., **180s** per call.

4) **Write XML (atomic)**
   - Write to a temp file in `RESULTS_DIR` then rename to `{jobId}.xml`.
   - Verify file exists and size > 0 before marking complete.

5) **Complete / Fail**
   - On success: set `result_path`, `status='complete'`, `completed_at`, clear lease fields, bump `updated_at`.
   - On failure: set `status='failed'`, `failed_at`, `error_code`, `error_message` (one-liner), clear lease fields, bump `updated_at`.
   - Map all failures (see “Error mapping” below).

6) **Loop policy**
   - If a job was claimed and processed, loop immediately (no sleep).
   - If nothing was available to claim, sleep briefly (e.g., 1–2s) before trying again.

### Error mapping (authoritative)
- **400/406/413/415** → `GW_4XX` (terminal; no retry).
- **5xx from Gateway** → `GW_5XX` (retryable).
- **Network error (ECONNRESET/ECONNREFUSED/etc.)** → `GW_5XX` (retryable).
- **Timeout** → `GW_TIMEOUT` (retryable).
- **Local write/read failure** → `IO_ERROR` (retryable once; treat as transient unless disk full).

### Retries (conceptual; details in Phase 4)
- Keep retry logic thin here or add it now if you prefer: backoff with jitter (`5s × 2^attempt + random(0–5s)`, max 3).

### Circuit breaker (basic, hold-queue mode)
- Track 5xx/timeouts in a sliding window.
- If above threshold, **pause new dispatches** (leave jobs `queued`) until Gateway health normalizes.
- Keep this simple; no need for fancy half-open states for MVP.

### Graceful shutdown (SIGTERM)
- Stop claiming new work.
- Finish current job; if you cannot finish, **cleanly requeue** (clear lease; set `status='queued'`).
- Disconnect DB only after the final status write.

### Paths & storage (Option-2 Docker)
- Configure absolute directories:
  - `UPLOADS_DIR=/app/uploads`
  - `RESULTS_DIR=/app/results`
- `mkdir -p` both dirs **inside the worker** at start; do not assume host created them.
- Never trust `original_filename` for reads/writes.

### Env & config
- `DATABASE_URL` (same as web): `postgresql://postgres:postgres@postgres:5432/convert_jobs_dev?schema=public`
- `GATEWAY_URL` (internal service URL)
- `WORKER_CONCURRENCY` (start 2–4)
- `WORKER_LEASE_TTL_SEC` (e.g., 600)
- `GATEWAY_TIMEOUT_MS` (e.g., 180000)
- `RETRY_MAX_ATTEMPTS` (e.g., 3)
- `UPLOADS_DIR`, `RESULTS_DIR` as above

### Observability (minimal, now)
- **Structured logs** (JSON) for each step with fields:
  - `event` (`reclaim|claim|start|gateway_ok|gateway_error|complete|failed|shutdown`)
  - `job_id`, `status`, `duration_ms`, `attempt`, `gateway_status` (when present), `error_code`.
- Use `job_id` as correlation id across web and worker.

---

## Scope (Later)
- Memory-to-disk streaming for very large XMLs (if needed).
- Advanced circuit breaker tuning and metrics dashboards.
- `job_events` timeline (persisted) if not added in Phase 1.

---

## Tests

### Unit
- Reclaim function requeues expired `processing`.
- Claim function updates exactly one queued job and returns it (no double-pickup).
- Mapping allow-list validator.
- Result writer uses temp→rename and verifies size > 0.

### Integration
- **Happy path**: queued → processing → complete; XML present; status correct.
- **Gateway 400/406**: job ends `failed` with `GW_4XX`; no retry.
- **Gateway 5xx / network**: job retried (if enabled) and eventually `complete` or `failed` with `GW_5XX`.
- **Timeout**: mapped to `GW_TIMEOUT` with backoff; respects max attempts.
- **Stuck job**: simulate worker crash mid-processing → lease expires → reclaim path requeues → processed successfully.
- **SIGTERM**: during processing → finishes or cleanly requeues before exit.

### Manual
- Verify containers create `/app/uploads` and `/app/results` on boot.
- Flip Gateway offline: breaker holds queue; when Gateway returns, processing resumes.

---

## Exit criteria
- Worker **never double-processes** a job.
- **Expired processing leases are reclaimed automatically** and jobs are requeued.
- **SIGTERM** finishes or cleanly requeues the current job.
- All failure classes mapped to the standard error codes with one-line messages.
- XML writes are atomic and verified; `result_path` only set on `complete`.
- Minimal structured logs present with `job_id` and durations.
- DB name/URL and field naming are consistent with Phase 1 (no schema drift).
