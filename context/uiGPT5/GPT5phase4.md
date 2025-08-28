
# Phase 4 — Reliability Layer (v2, high-level)

> Purpose: lock in automatic retries, a simple circuit breaker, manual retry, and clear errors — aligned with Phase 1–3 decisions and avoiding over‑complexity for MVP.

## 1) What stays from your draft (good calls)
- Exponential backoff with jitter for transient failures.
- Circuit breaker to protect the gateway.
- Manual retry endpoint + button.
- Concurrency limits, timeouts, and lease extension for long jobs.
- Tracking attempts and last attempt times.
- Optional dead‑letter marking for permanently failed jobs.

## 2) What we’re changing (to keep it tight)
- **Canonical error codes (unchanged outwardly):** keep the shared set — `NOT_PDF`, `TOO_LARGE`, `GW_4XX`, `GW_5XX`, `GW_TIMEOUT`, `IO_ERROR`, `NOT_READY`, `EXPIRED`, `FORBIDDEN`, `UNKNOWN`. Map any extra internal nuances to these for UI and API responses. (e.g., `GW_UNAVAILABLE` → `GW_5XX`; `INVALID_MAPPING` → `GW_4XX`; parsing/validation internals → `GW_4XX` or `UNKNOWN` as appropriate.)
- **Circuit breaker (basic “hold‑queue” mode now):** no HALF_OPEN logic yet. When error rate breaches threshold, **pause dispatch**, keep jobs `queued`, and auto‑resume when healthy.
- **Retry selection:** integrate `retry_after` directly into the **claim** SQL, so workers skip items scheduled for the future.
- **Leases only for reclaim:** don’t use leases to gate `queued` selection; use them to recover stuck `processing` jobs (expired lease → requeue).
- **Field naming & DB alignment:** keep names consistent with Phase 1 (camelCase in Prisma client, single DB name).

## 3) Scope (Now)

### 3.1 Error taxonomy (canonical + mapping)
- Public/UI codes: as above.
- Internal mapping examples:
  - `GW_UNAVAILABLE`, network errors → `GW_5XX`
  - `PARSE_ERROR`, `VALIDATION_ERROR`, `INVALID_MAPPING` → `GW_4XX`
  - `MEMORY_ERROR` → `UNKNOWN` (or `IO_ERROR` if it’s local resource pressure)
- Messages: one‑liners; no stack traces or server paths.

### 3.2 Retry policy
- **Max attempts:** 3.
- **Delay formula:** `delay = 5000ms * 2^attempt + random(0–5000ms)` (attempt starts at 0).
- **Retryable:** `GW_5XX`, `GW_TIMEOUT`, `IO_ERROR`, `UNKNOWN` (only if not user‑induced). No retry for `GW_4XX`.
- **State fields:** `attemptCount`, `lastAttemptAt`, **`retryAfter`**.
- **On retry schedule:** set `status='queued'`, clear lease fields, bump `updated_at`.
- **Indexing:** add `(status, retryAfter)` for efficient picking.

### 3.3 Circuit breaker (basic)
- **Trigger:** sliding window of gateway calls; open when failures (5xx/timeouts) exceed threshold (e.g., ≥50% of last 20 calls or 1–2 minutes).
- **Behavior:** when **OPEN**, worker does not dispatch new jobs — it leaves them `queued` and logs breaker state.
- **Recovery:** when health probe shows success rate is back under threshold for a short window, **CLOSED** automatically.
- **UI:** optional banner “Converter busy — jobs will resume automatically.”

### 3.4 Worker loop (authoritative flow)
- **Reclaim step:** requeue `processing` jobs whose `lease_expires_at < NOW()`; clear `leased_by`.
- **Claim step:** in a **short transaction**, pick from `status='queued'` **where (`retry_after IS NULL OR retry_after <= NOW()`)**, ordered by `created_at`, using `FOR UPDATE SKIP LOCKED`; set `status='processing'`, `leased_by`, `lease_expires_at`, `started_at=COALESCE(started_at, NOW())`, bump `updated_at`.
- **Process:** call gateway with timeout; on success write XML atomically; on failure map error and either schedule retry or mark failed.
- **Loop control:** if a job was processed, loop again immediately; if none claimed, sleep ~1–2s.

### 3.5 Lease extension & graceful shutdown
- **Lease extension:** extend every ~30s for long jobs (`lease_expires_at = NOW()+TTL`).
- **SIGTERM:** stop claiming, finish the in‑flight job; if it can’t finish, requeue cleanly (clear lease, set `status='queued'`). Disconnect from DB only after the final status write.

### 3.6 Manual retry
- **API:** `POST /api/jobs/:id/retry` (ownership‑scoped). Preconditions: `status='failed'` and source PDF exists.
- **Behavior:** reset error fields, zero `attemptCount` (or keep; your choice), set `status='queued'`, bump `queuedAt`/`updated_at`.
- **UI:** show “Retry” for failed rows; disabled if source missing.

### 3.7 Observability (minimum viable now)
- **Structured logs** on worker actions: `event`, `job_id`, `status`, `attempt`, `duration_ms`, `gateway_status`, `error_code`, breaker state.
- **Metrics (counters/gauges):** jobs created/completed/failed{code}, queue depth, gateway P95 latency, retries scheduled, breaker open time.
- **Events (optional):** `job_events` for `queued|processing|retry|complete|failed|expired` with small JSON meta.

## 4) Scope (Later)
- Half‑open circuit breaker with probe slots.
- Distributed tracing; dashboard SLOs.
- Formal DLQ with a separate queue/collection instead of a boolean flag.
- Job cancellation & priority queues.
- Webhook notifications.
- Per‑user rate limits beyond session caps (still recommended in Phase 5).

## 5) Tests
- **Unit:** backoff calculation; retryability by code; breaker open/close thresholds; reclaim logic.
- **Integration:** gateway 400→`GW_4XX` (no retry); 502/timeout→retries with spacing; SIGTERM during processing→complete or clean requeue; `retry_after` respected by claim.
- **Manual:** breaker opens under forced faults; resumes on recovery; UI Retry requeues; long job lease extends and completes.

## 6) Exit criteria
- No duplicate processing; expired leases are reclaimed automatically.
- Retry spacing matches backoff; capped at 3 attempts; `retry_after` honored by claim.
- Basic breaker pauses dispatch during gateway failure and auto‑recovers.
- Manual retry works only for owners and only when source exists.
- Logs and minimal metrics support debugging.
- Field names/DB align with Phase 1–3; no schema drift.

## 7) Config knobs (env)
- `RETRY_MAX_ATTEMPTS`, `RETRY_BASE_DELAY_MS`, `RETRY_JITTER_MAX_MS`
- `WORKER_LEASE_TTL_SEC`, `GATEWAY_TIMEOUT_MS`, `WORKER_CONCURRENCY`
- `CIRCUIT_WINDOW`, `CIRCUIT_FAIL_THRESHOLD`, `CIRCUIT_COOLDOWN_MS`
- (Existing) `DATABASE_URL`, `GATEWAY_URL`, `UPLOADS_DIR`, `RESULTS_DIR`

-- End
