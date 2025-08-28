# Step 9 — Failure handling & retries

## 1) Shared error taxonomy (one set of codes everywhere)

Use these codes across API responses, job records, logs, and UI copy:

* `NOT_PDF` — server-side validation: wrong type
* `TOO_LARGE` — size > limit
* `GW_4XX` — gateway said your request was invalid (400/406/413/415)
* `GW_5XX` — gateway/server error
* `GW_TIMEOUT` — gateway call exceeded timeout
* `IO_ERROR` — read/write failed (disk/S3)
* `NOT_READY` — trying to download before complete
* `EXPIRED` — artifact purged by retention
* `FORBIDDEN` — ownership check failed
* `UNKNOWN` — catch-all

Each job stores `error_code` + a short, human message in `error_message`.

---

## 2) Where failures happen and what we do

### A) Upload API (`POST /api/upload`)

* **Validate early**: reject non-PDFs (`NOT_PDF` / 400) and >50MB (`TOO_LARGE` / 413).
* **Disk write failure**: set job `failed` with `IO_ERROR` / 500.
* **Dedupe**: if we find an in-progress or complete twin, return that job; don’t create a new one.

**Retry?** No automatic retry on the server here. The browser can re-POST if the network blips; idempotency is protected by dedupe (hash+mapping).

---

### B) Worker → Gateway (PDF→XML)

* **Map responses**:

  * 400/406/413/415 → `GW_4XX` (do not retry)
  * 5xx or network error → `GW_5XX` (retryable)
  * timeout → `GW_TIMEOUT` (retryable)
* **On success**: write XML. If write fails → `IO_ERROR` (retryable once; treat as transient if disk isn’t full).

**Retry?** Yes, for transient cases (see policy below).

---

### C) Download API (`GET /api/jobs/:id/download`)

* Not complete → `409` + `NOT_READY`.
* Missing artifact (expired or lost) → `404` + `EXPIRED`.
* Not owner → `403` + `FORBIDDEN`.

**Retry?** Client may retry a moment later for `NOT_READY`. For `EXPIRED`, user must re-upload.

---

## 3) Automatic retry policy (worker)

**When to retry**

* `GW_5XX`, `GW_TIMEOUT`, `IO_ERROR` → retry
* `GW_4XX`, `NOT_PDF`, `TOO_LARGE` → don’t retry (terminal)

**Backoff**

* Exponential with jitter, e.g. 5s, 15s, 45s (±20%)
* Cap attempts with `RETRY_MAX_ATTEMPTS` (default 3)

**Bookkeeping**

* Increment `attempt_count` on every dispatch
* Set `last_attempt_at` and `error_*` on failures
* On final failure, set `status=failed`, `failed_at`

**Leases**

* Keep lease while attempting; extend TTL during long calls
* If worker dies, lease expires and another worker can resume (attempt\_count continues)

---

## 4) Circuit breaker (protect the gateway)

Two modes (configurable):

* **Hold-queue (default, safer UX)**
  When failure rate crosses a threshold (e.g., ≥50% `GW_5XX/GW_TIMEOUT` over 2–5 min), **pause new dispatches**. Leave jobs `queued`. Show “Gateway busy, paused. Will retry automatically.” Resume once the breaker closes.

* **Fail-fast (optional, ops-friendly)**
  Same threshold, but immediately mark new dispatches as `failed` with `GW_5XX`. Use when you prefer quick visibility in dashboards over automatic catch-up.

Either way, keep a small health probe to flip the breaker back when the gateway recovers.

---

## 5) Manual retry (API and UI)

**Endpoint**: `POST /api/jobs/:id/retry`
**Preconditions**:

* Job is `failed`
* Source PDF still exists (or stored in S3)
* Ownership verified

**Behavior**:

* Clear `error_code/message`, reset `lease_*`
* Set `status=queued`, bump an optional `manual_retry_count`
* Worker picks it up according to normal policy

In the queue UI, show a small **Retry** link for failed rows (non-blocking nice-to-have).

---

## 6) Friendly, consistent error messages

Map codes to user-facing one-liners (store the full technical reason in logs):

* `NOT_PDF`: “Only PDF files are supported.”
* `TOO_LARGE`: “File exceeds 50 MB limit.”
* `GW_4XX`: “Couldn’t convert this file with the selected mapping.”
  (If safe, append the gateway message: e.g., “Unsupported mapping.”)
* `GW_5XX`: “Converter service is having an issue. We’ll retry shortly.”
* `GW_TIMEOUT`: “Conversion is taking too long. We’ll retry.”
* `IO_ERROR`: “Temporary storage issue. We’ll retry.”
* `NOT_READY`: “Conversion not finished yet.”
* `EXPIRED`: “File was removed by retention. Re-upload to regenerate.”
* `FORBIDDEN`: “This file isn’t yours.”

The queue page shows only the short line; no stack traces or paths.

---

## 7) State transitions (authoritative)

* `uploaded → queued` (job created ok)
* `queued → processing` (lease acquired; `started_at` set)
* `processing → complete` (XML written; `result_path` set)
* `processing → failed` (set `error_*`, `failed_at`)
* `failed → queued` (manual retry)
* **During retries**: remain `processing` between attempts; if you release the lease between attempts, temporarily set back to `queued` so a new worker can pick it up.

**Invariants** (double-down)

* `result_path != NULL` only when `status=complete`
* `error_* != NULL` only when `status=failed`
* Lease fields set only when `status=processing`

---

## 8) Idempotency & duplicates

* At upload: dedupe by `(owner_session_id, sha256, mapping, bytes)` to avoid creating duplicate work.
* In worker: if `result_path` already exists and the file is present, **skip processing** (treat as success). This covers cases where a previous attempt actually finished but the status update stalled.

---

## 9) Observability hooks (to help you debug)

* Emit a `job_event` on each transition: `queued`, `processing`, `retry`, `complete`, `failed`.
  Include `attempt`, `gateway_http_status`, `duration_ms`, and `error_code` in `meta`.
* Metrics to watch:

  * `jobs_failed_total{error_code}` (alert on spikes)
  * `job_processing_duration_seconds` (watch P95/P99)
  * `queue_depth` and `jobs_active` (stuck queue = lease issues)
  * `manual_retry_total`

---

## 10) Runbook (what to do when things go wrong)

* **Many `GW_5XX` or `GW_TIMEOUT`**: breaker opens → check gateway health, logs, and CPU/memory. Keep jobs queued; once healthy, breaker closes and backlog drains.
* **Mostly `GW_4XX`**: mapping problem or invalid inputs → inspect sample job, confirm mapping, improve UI copy.
* **`IO_ERROR` spikes**: disk/S3 issue or permissions → check free space/credentials; consider pausing uploads (hard limit) until resolved.
* **Leases stuck** (`processing` for too long): confirm worker liveness; expired leases should allow another worker to take over. If not, check lease clock skew or transaction boundaries.

---

## 11) Acceptance checks (end-to-end)

* Upload a **bad type** → job `failed` with `NOT_PDF`, 400 on API.
* Upload a **>50MB** dummy → 413 with `TOO_LARGE`.
* Force a **gateway 400/406** (bad mapping) → job `failed` with `GW_4XX`, no retries.
* Simulate **gateway down** → jobs either stay `queued` (hold-queue) or fail fast (if configured). When gateway recovers, processing resumes (or manual retry succeeds).
* Simulate **timeout** → worker retries up to `RETRY_MAX_ATTEMPTS` with exponential backoff, then marks `failed` with `GW_TIMEOUT`.
* Simulate **IO write failure** on results → one retry; if still failing, `IO_ERROR`.
* Click **Download** before complete → 409 `NOT_READY`; after retention cleanup → 404 `EXPIRED`.
* Use **manual retry** on a failed job → back to `queued`, then completes normally when gateway is healthy.
* Verify **no double XML** and correct leasing when a worker dies mid-run.
