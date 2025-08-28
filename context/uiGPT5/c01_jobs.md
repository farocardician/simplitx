# Step 1 — “Jobs” as the single source of truth (detailed)

## 0) Scope and purpose

Track every uploaded PDF as a **Job** from birth to finish. The web UI reads Jobs to render the queue; the worker updates Jobs as it calls the Gateway and writes the XML. This remains stable even when we add LLM validation/re-extraction later.

---

## 1) Entities (now vs later)

### Now

1. **jobs** — the canonical record (one row per uploaded file).
2. **job\_events** — append-only audit trail (optional but recommended).
3. **job\_artifacts** — optional if you want to attach multiple files per job (source PDF, result XML, logs, previews, etc.).

### Later (keep outside `jobs` to stay clean)

* **llm\_checks** — model, prompt version, confidence, outputs, FK→job.
* **revisions** — user edits (diffs or full payloads) to create training gold.
* **training\_samples** — normalized examples to export to model training.

---

## 2) Jobs table (authoritative schema — no code)

**Primary key**

* `id` — UUID v4

**Ownership**

* `owner_session_id` — TEXT, nullable; set for anonymous sessions (cookie).
* `user_id` — UUID, nullable; backfill if/when auth exists.

> Access control: list/fetch only where `user_id = current_user` **OR** `owner_session_id = current_session`.

**File + mapping identity**

* `original_filename` — TEXT (never trusted for paths).
* `content_type` — TEXT, default `application/pdf`.
* `bytes` — BIGINT > 0.
* `sha256` — CHAR(64), hex digest of file contents (used for dedupe).
* `mapping` — TEXT, e.g., `pt_simon_invoice_v1` (default for now).

**Lifecycle**

* `status` — ENUM text: `uploaded | queued | processing | complete | failed`.
* `upload_path` — TEXT (server-generated absolute/anchored path).
* `result_path` — TEXT, nullable (filled when complete).
* `error_code` — TEXT, nullable (e.g., `NOT_PDF`, `TOO_LARGE`, `GW_4XX`, `GW_5XX`, `GW_TIMEOUT`, `IO_ERROR`).
* `error_message` — TEXT, nullable (brief, user-readable line).
* Timestamps:

  * `created_at` (default now)
  * `queued_at`
  * `started_at`
  * `completed_at`
  * `failed_at`

**Leasing (safe concurrency)**

* `leased_by` — TEXT, nullable (worker id / hostname).
* `lease_expires_at` — TIMESTAMPTZ, nullable (short TTL, e.g., 5–10 minutes).

> Lets workers “lock” a job without deadlocks; supports retrying stuck work.

**Retention + telemetry**

* `expires_at` — TIMESTAMPTZ, nullable (cleanup schedule).
* `download_count` — INT, default 0.
* `first_downloaded_at` — TIMESTAMPTZ, nullable.

**Optional relationship for dedupe transparency**

* `duplicate_of` — UUID, nullable FK→jobs.id
  (If you choose to return a new row that points to the canonical completed job instead of reusing the same id.)

---

## 3) Indices and constraints

* `PK (id)`
* `IDX jobs (status, created_at DESC)` — queue/worker and dashboards.
* `IDX jobs (owner_session_id, status)` — “my queue” fast reads.
* `IDX jobs (lease_expires_at)` — find stale leases.
* **Dedupe (pick one):**

  * **Per-owner dedupe (safer for multi-tenant):**
    `UNIQUE (owner_session_id, sha256, mapping, bytes)` (NULLs allowed for `owner_session_id` if you always set it).
  * **Global dedupe (strongest dedupe, shared across users):**
    `UNIQUE (sha256, mapping, bytes)`
    Use only if sharing identical results between users is acceptable.
* `CHECK (bytes > 0)`
* `CHECK (status IN ('uploaded','queued','processing','complete','failed'))`

---

## 4) State machine (allowed transitions + invariants)

**Transitions**

* `uploaded → queued` (after job creation and file saved)
* `queued → processing` (worker starts; set lease and `started_at`)
* `processing → complete` (write XML; set `result_path`, `completed_at`)
* `processing → failed` (set `error_*`, `failed_at`)
* `queued → failed` (e.g., gateway unavailable + circuit breaker)
* `failed → queued` (manual retry; clear `error_*`, reset lease fields)

**Invariants**

* `result_path IS NOT NULL` only when `status = 'complete'`
* `error_code/message IS NOT NULL` only when `status = 'failed'`
* When entering `processing`: set `started_at`, `leased_by`, `lease_expires_at`
* When entering `complete`: `completed_at` must be set and file must exist
* Leases expire and may be re-acquired by another worker (idempotent work)

---

## 5) Dedupe policy (idempotency)

**Why**: If the same PDF (same content hash) with the same mapping is uploaded repeatedly, you can avoid duplicate processing.

**Flow**

1. On upload, compute `sha256`.
2. Lookup an existing job with the chosen dedupe scope:

   * **Per-owner**: `(owner_session_id, sha256, mapping, bytes)`.
   * **Global**: `(sha256, mapping, bytes)`.
3. If a **complete** job exists with a valid `result_path`:

   * Either **reuse** that job id, or
   * Create a new job with `duplicate_of = existing_id` and `status = complete` (link back to the canonical one).
4. If a matching job is **in progress**: return the existing job id and show its status in the queue.

**Note**: Start with **per-owner dedupe**. You can migrate to global dedupe later.

---

## 6) Ownership model (no full auth yet)

* On first visit, issue a random **`owner_session_id` cookie** (UUIDv4; httpOnly, sameSite).
* All job reads/writes are scoped to this session unless `user_id` exists.
* If you add auth later, you can **backfill `user_id`** and keep `owner_session_id` for historical rows. Queries become `(user_id || owner_session_id)`.

---

## 7) Paths and storage (local now, S3 later)

* **Local layout** (inside the web container’s mounted volume):

  * `uploads/{jobId}.pdf`
  * `results/{jobId}.xml`
* Persist server-generated paths in DB; **never** trust `original_filename` for writing/serving.
* Future swap: add `job_artifacts.storage = 'local'|'s3'` and `path_or_key` to abstract storage without touching `jobs`.

---

## 8) Retention policy

* Source PDFs: keep **N days** (e.g., 7).
* XML results: keep **M days** (e.g., 30) or **delete on first download** if you prefer.
* Use `expires_at` and a daily cleanup task to:

  * Delete files from disk.
  * Null `upload_path`/`result_path` (or mark the row archived).
  * Optionally write a `job_event` of type `expired`.

---

## 9) Error taxonomy (consistent UX)

Use `error_code` and a short `error_message`:

* `NOT_PDF` — rejected at upload validation.
* `TOO_LARGE` — client/server size cap exceeded (match Gateway limit).
* `GW_4XX` — Gateway returned 4xx (bad mapping, unsupported file).
* `GW_5XX` — Gateway returned 5xx.
* `GW_TIMEOUT` — call timed out.
* `IO_ERROR` — disk write/read problems.
* `UNKNOWN` — fallback if unclassified.

UX can map these codes to friendly messages.

---

## 10) Worker coordination (no code, just the contract)

**Selecting work (safe and efficient)**

* Query **queued** jobs with **expired or null lease**, order by `created_at`, limit N.
* In one transaction:

  * Set `leased_by`, `lease_expires_at = now() + interval '5 minutes'`,
  * Transition `status` to `processing`,
  * Set `started_at`.

**Heartbeat / extension (optional)**

* Workers may periodically extend `lease_expires_at` while processing.
* If a worker crashes, leases expire and the next worker can take over.

**Completion**

* On success: write `result_path`, set `status=complete`, `completed_at`.
* On failure: set `status=failed`, `error_*`, `failed_at`.

**Events**

* Insert `job_events` for: created, queued, processing, complete, failed, retry, downloaded, expired.
* `job_events.meta` (JSONB) can capture gateway URL, HTTP status, duration\_ms, etc.

---

## 11) Indexing for the queue page

The queue page needs:

* “My jobs” by most recent → `IDX (owner_session_id, created_at DESC)`
* Filter by active statuses → `IDX (owner_session_id, status)`
* Stop polling when **all terminal** (complete/failed) → quick count:

  * `COUNT(*) WHERE owner_session_id = ? AND status IN ('uploaded','queued','processing')`

---

## 12) Migration plan (Prisma)

* **Migration 001**

  * Create `jobs` with all columns above.
  * Add indices (status+created\_at, owner\_session\_id+status, lease\_expires\_at).
  * Add dedupe unique index (choose per-owner or global).
* **Migration 002 (recommended)**

  * Create `job_events` (id, job\_id, event\_type, at, meta JSONB + FK+index).
* **Migration 003 (optional)**

  * Create `job_artifacts` if you want multi-file attachments per job.

Environment for dev (Option 2 Docker):
`postgresql://postgres:postgres@postgres:5432/convert_jobs_dev?schema=public`

---

## 13) Security notes

* Serve files **only** via `GET /api/jobs/:id/download` after verifying ownership; never by raw path.
* Validate content type and size **server-side** (mirror client limits).
* Normalize/anchor paths; only write under your controlled directories.
* Consider short-lived **signed download tokens** later if you want shareable links.

---

## 14) Acceptance criteria (for Point 1 only)

* Creating a job row never fails silently; either:

  * `status=uploaded` with valid `upload_path` and hash, or
  * `status=failed` with `error_*` set.
* From a fresh database:

  * Upload **one** PDF → exactly **one** `jobs` row is created.
  * Upload the **same** PDF again (same session, same mapping) → dedupe rule applies (as chosen).
  * Status transitions respect invariants (result only when complete, errors only when failed).
  * Worker can lease, process, complete, and release jobs safely; a crashed lease is recoverable.
* Queue page can list only **my** jobs quickly (indexed).