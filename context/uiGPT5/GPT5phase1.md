
# Phase 1 — Foundation Layer (v2)

> High-level, code-free. This patches the original Phase 1 so it fits your Docker Option‑2 setup and early guardrails.

## Goal
Establish a safe upload→job creation path with Postgres+Prisma, per‑owner dedupe, and a clean `/api/jobs` list that supports incremental polling.

---

## Scope (Now)

### Data model (Postgres + Prisma)
- `jobs` table with:
  - `id` (uuid, pk), `owner_session_id` (text) and/or `user_id` (uuid, null)
  - `original_filename` (text), `content_type` (text, default `application/pdf`), `bytes` (bigint>0)
  - `sha256` (char(64) lowercase hex) — **normalize to lowercase**
  - `mapping` (text) — **server allow‑list**; default `pt_simon_invoice_v1`
  - `status` (enum: `uploaded|queued|processing|complete|failed`)
  - `upload_path` (text), `result_path` (text, null)
  - `error_code`, `error_message` (text, null)
  - timestamps: `created_at`, `queued_at`, `started_at`, `completed_at`, `failed_at`
  - **`updated_at`** with Prisma `@updatedAt` (used for incremental polling)
- Indexes:
  - **Per‑owner dedupe**: unique (`owner_session_id`, `sha256`, `mapping`, `bytes`)
  - Reads: (`owner_session_id`, `created_at DESC`), (`owner_session_id`, `status`), (`status`, `created_at DESC`)
- Invariants (enforced in app now, DB later):
  - `result_path` is set **only** when `status='complete'`
  - `error_*` are set **only** when `status='failed'`

### Session & ownership
- Anonymous session cookie `owner_session_id` (httpOnly, SameSite=Lax; **Secure=true in prod**). All reads/writes are scoped to this session (or user_id when you add auth).

### Upload API — `POST /api/upload`
- Accept a single file via `multipart/form-data`.
- Validation (server‑side):
  - **PDF‑only** by both MIME **and magic bytes** (`%PDF` at start) — reject renamed files
  - Size ≤ **50 MB** → otherwise `413`
  - `mapping` must be in allow‑list → otherwise `400`
- Behavior:
  - Create uploads dir if missing; **write atomically** (temp → rename), then verify `size > 0`
  - Compute **lowercase** SHA‑256
  - Create the job row and set `status='queued'` in the same request (don’t leave it as `uploaded` in the response)
  - Save file at `uploads/{jobId}.pdf` (server‑generated path only)
  - Response:
    ```jsonc
    { "job": { "id": "...", "status": "queued", "filename": "...", "bytes": 123, "created_at": "...", "mapping": "pt_simon_invoice_v1" },
      "deduped_from": "uuid-or-null" }
    ```

### Jobs list — `GET /api/jobs`
- Filters jobs by **current session**.
- Supports `?since=<ISO>` using **`updated_at`** for incremental polling.
  - Note: use `>=` comparison server‑side; clients should de‑dupe by `id` to handle boundary duplicates.
- Returns: `jobs[]` (id, filename, bytes, status, created_at, completed_at, error, mapping), `active_count` (count of `uploaded|queued|processing`), `next_cursor` (optional).

### Storage (local, Option‑2 Docker)
- Local paths inside container: `/app/uploads` and `/app/results` (results used in Phase 2).
- Keep files **outside** public web root. Only the download API will stream files (Phase 3).

### Env & Docker (Option 2)
- **DATABASE_URL** (inside containers):  
  `postgresql://postgres:postgres@postgres:5432/convert_jobs_dev?schema=public`
- Web app runs **in Docker** and depends on `postgres` **health**; volumes mounted for `/app/uploads`.

### Minimal structured logs (now)
- JSON logs with: `route`, `status`, `duration_ms`, `session_id`, `job_id` (when applicable). Keep server paths out of logs.

---

## Scope (Later)
- `job_events` and `job_artifacts` tables
- S3 storage backend (same keys/paths)
- Auth users beyond anonymous sessions

---

## Tests

### Unit
- PDF validator (MIME + **magic bytes**), size limit
- SHA‑256 normalization (lowercase), mapping allow‑list
- Dedupe key built as (`owner_session_id`, `sha256`, `mapping`, `bytes`)

### Integration
- Valid PDF upload → job row created with `status='queued'` and file written
- Oversized file → `413` with a friendly JSON error
- Unknown mapping → `400` with a friendly message
- `GET /api/jobs?since=` returns only changed rows (client de‑dupes boundary cases)

### Manual
- Duplicate upload (same session, same mapping) returns `deduped_from` and does **not** create new work
- Different session uploads same file → two distinct jobs (per‑owner dedupe)
- Missing `/app/uploads` on container start → handler autocreates it and writes atomically

---

## Exit criteria
- Uploads succeed for valid PDFs, fail cleanly for invalid/oversized/unknown mapping.
- DB row has all mandatory fields; **`updated_at`** changes on modification and drives `?since=` polling.
- Duplicate uploads return `deduped_from` and do not re‑process.
- Local file is present at `uploads/{jobId}.pdf`, verified non‑empty.
- Logs contain route + `job_id` for each successful upload, with duration.

---

## Notes for Phase 2 alignment
- Worker will select `queued` jobs via **`SELECT … FOR UPDATE SKIP LOCKED`** (no long locks).
- Leases (TTL/heartbeat) will be used **only** to reclaim stuck `processing`.
- Gateway calls, retries with jitter, circuit breaker, and graceful shutdown come in Phase 2.
