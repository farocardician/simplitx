# High-level plan (v3)

## 1) One “Jobs” source of truth

- **DB:** Postgres + Prisma. One row per uploaded file.
- **Shape (core):** `id`, `owner_session_id`/`user_id`, `original_filename`, `bytes`, `sha256`, `mapping`, `status`, `upload_path`, `result_path?`, `error_code?`, `error_message?`, timestamps (`created_at`, `queued_at?`, `started_at?`, `completed_at?`, `failed_at?`), `updated_at` (auto).
- **Keys/indexes:** per-owner dedupe on `(owner_session_id, sha256, mapping, bytes)`, plus `(owner_session_id, created_at DESC)`, `(owner_session_id, status)`, `(status, created_at DESC)`.
- **Dedupe:** Per-owner. If identical file+mapping exists and is complete, reuse; if in-progress, return existing job.
- **Paths:** store only server-generated paths; files live outside web root.
- **Notes:** Use `updated_at` for incremental polling and cache invalidation.

## 2) Minimal API surface (predictable)

- `POST /api/upload` — create job for 1 PDF; returns `{ job, deduped_from? }`. Enforce **PDF + 50MB** and mapping allow-list. **Rate limit:** 10 uploads/min per session (429 with `Retry-After`).
- `GET /api/jobs` — list jobs for current session. Supports `?since=<ISO>` (optional incremental), `?status=`, `limit/cursor`. Response includes `active_count` to stop polling.
- `GET /api/jobs/:id` — detail (ownership-scoped).
- `GET /api/jobs/:id/download` — stream XML when `status=complete`; 409 if not ready; 404 if expired.
- (Later) `POST /api/jobs/:id/retry` — re-queue failed jobs when source PDF exists.

## 3) Background processing (robust, swappable)

- **Selection:** Use `SELECT … FOR UPDATE SKIP LOCKED` to atomically pick from `status='queued'`. Keep short transactions; never hold DB locks during gateway calls.
- **Leases:** Only for reclaiming stuck `processing` (TTL + optional heartbeat). Not needed for pick-up thanks to `SKIP LOCKED`.
- **Gateway call:** `POST /process` with `Accept: application/xml`, `mapping`, file. Save XML → `results/{jobId}.xml` → mark `complete`.
- **Retries:** Exponential backoff with jitter: `5s × 2^attempt + random(0–5s)`, max 3. Retry on `GW_5XX`, timeouts, transient IO; no retry on `GW_4XX`.
- **Circuit breaker:** If 5xx/timeout rate crosses threshold, pause new dispatches (hold in `queued`) until healthy.
- **Graceful shutdown:** On SIGTERM, finish current job (or cleanly release) and refuse new work.

## 4) Queue page UX (live feel, polling first)

- Redirect to `/queue` after upload; poll `GET /api/jobs` every 3–5s, back off when idle; stop when `active_count=0`.
- Buttons: **Review** (placeholder/disabled), **Download** (enabled only on `complete`).
- **Progress hint:** show rough “~N sec remaining” based on historical size→duration (hide for outliers; target ±50%).
- **Labels:** show mapping tag; show “Reused result” chip when deduped.

## 5) Storage + retention

- Paths: `uploads/{jobId}.pdf`, `results/{jobId}.xml`; atomic writes (temp→rename) and size>0 check before marking complete.
- Retention knobs: `PDF_TTL_DAYS` (~7), `XML_TTL_DAYS` (~30) or delete on first download. Daily cleanup respects active jobs.
- Shard paths when file count grows (e.g., `yy/mm/dd/...`).

## 6) Mapping handling

- Default: `pt_simon_invoice_v1`. Server-side allow-list only; reject unknown mappings early.
- Keep a small mapping registry (default + available). Worker validates before calling gateway.

## 7) Security & guardrails

- **Validation:** server enforces PDF-only, size limit, and mapping allow-list. Validate magic bytes (`%PDF`) in addition to extension/MIME.
- **Ownership:** scope all list/detail/download by session/user. Serve files **only** via the download endpoint; never by path.
- **Headers/CORS:** security headers, HTTPS in prod, CORS locked to origin.
- **Rate limits:** uploads at 10/min per session; optional IP caps.

## 8) Observability

- **Correlation:** use `job_id` end-to-end across web, worker, and gateway.
- **Events:** optional `job_events` (queued, processing, retry, complete, failed, expired) with JSON meta (status, durations).
- **Metrics:** queue depth; jobs by state; failures by `error_code`; gateway latency P95/P99; storage bytes; cleanup counts.
- **Health:** `/api/healthz` for web; compose healthchecks for gateway/services.

## 9) Failure handling & retries

- **Codes:** `NOT_PDF`, `TOO_LARGE`, `GW_4XX`, `GW_5XX`, `GW_TIMEOUT`, `IO_ERROR`, `NOT_READY`, `EXPIRED`, `FORBIDDEN`, `UNKNOWN`.
- **Mapping:** 4xx → no retry; 5xx/timeout/IO → retry with backoff. Manual retry endpoint for failed jobs.
- **Download:** 409 if not ready; 404 if expired; 403 if not owner.

## 10) Performance & cost controls

- **Back-pressure:** cap worker concurrency (2–4 to start) and gateway calls.
- **Cache:** Redis cache for `/api/jobs` keyed by session for **2s**; invalidate on status change or `updated_at` bump. Expect ~80% fewer DB reads during polling.
- **DB:** indexes above match access patterns; short transactions; purge/compact `job_events` after 30–90 days.

## 11) Product polish (near-term)

- Clear limits copy; sticky counts (Total/Active/Completed/Failed); friendly one-line errors; “Upload more” CTA; optional “Retry” on failed rows.
- Reserve `/review/:id` route; consider “Download all” (zip) later.

## 12) Rollout in thin slices

1) **Jobs + redirect:** upload API creates jobs and redirects to `/queue` (static statuses ok).
2) **Worker hookup + circuit breaker (basic):** dispatch to gateway, write XML, update statuses; breaker pauses on spikes.
3) **Download:** enable streaming by job id.
4) **UX polish:** polling stop condition, friendly errors, mapping label, basic progress hint.
5) **Reliability & perf:** SKIP LOCKED selection, retries w/ jitter, Redis cache, retention cleanup, logs/metrics/alerts.

— End —

