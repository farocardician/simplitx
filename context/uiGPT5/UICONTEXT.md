# High-level plan (v2)

## 1) One “Jobs” source of truth

* Define a simple **Job** record: `{id, filename, status, created_at, completed_at?, error?, result_path?, bytes, hash, mapping}`.
* Generate a **content hash** on upload for deduping/idempotency (same file, same result).
* Use Postgres + Prisma.
* Keep files/results outside the web root; store only server-generated paths in the DB. Your web already writes to `uploads/` and has a proper upload route to extend. 
* Refer to ./c01_jobs.md

## 2) Minimal API surface (predictable)

* `POST /api/upload` → returns `{jobs:[{id,...}]}` immediately. Enforce the same **PDF+50MB** rules as the gateway. 
* `GET /api/jobs` → list jobs for current session/user for the queue page.
* `GET /api/jobs/:id` → detail view (status, error, timings).
* `GET /api/jobs/:id/download` → streams XML when ready.
* (Later) `POST /api/jobs/:id/retry` for failed jobs.

## 3) Background processing that’s easy to swap

* After upload, enqueue one task per job that calls the **Gateway** `/process` with `Accept: application/xml` and the chosen `mapping`; persist XML, update status. The gateway’s single public endpoint is port **8002**, and it already supports **PDF→XML** in one call. 
* Start with an in-process queue (bullmq/bee-queue/Lightweight worker). Keep the queue interface generic so you can switch to Redis later without refactors.
* Add a **circuit breaker**: if the gateway is down or returns 5xx repeatedly, pause new dispatches and mark jobs `failed` with a friendly message.

## 4) Queue page UX that feels live (polling first, SSE ready)

* Redirect to `/queue` after upload; poll `GET /api/jobs` every 3–5s; stop when all jobs are terminal.
* Button states: **Review** (disabled/placeholder), **Download** (enabled only when `complete`).
* Surface failures clearly with a single-line reason pulled from the job’s `error`.
* Keep your current multi-upload behavior (concurrency caps already described).

## 5) Storage + retention

* Paths: `uploads/{jobId}.pdf`, `results/{jobId}.xml`.
* Add **retention policy**: auto-delete source PDFs after N days; keep XML for M days, or on first download only.
* If/when you move to S3-compatible storage, keep the same DB schema and swap the writer/reader.

## 6) Mapping handling

* Default mapping: `pt_simon_invoice_v1`. Allow a dropdown later if you add more. The gateway supports **PDF→XML** with `mapping` today.

## 7) Security and guardrails

* Validate type/size on server; reject early with consistent JSON errors (align with the gateway’s 50MB and content rules). 
* Don’t trust filenames; always serve downloads via `GET /api/jobs/:id/download`.
* Add **short-lived signed download tokens** so links can be shared safely for a short window.
* Limit per-session upload concurrency (you already cap client concurrency).

## 8) Observability

* Add a **correlation id** to every job and pass it to the gateway request; log: queued, dispatched, processing, complete/failed, duration, bytes.
* Expose `GET /api/healthz` (you have it) and optionally a quick **gateway health probe** to short-circuit enqueueing when the gateway is down.

## 9) Failure handling and retries

* Mark `failed` with a concise `error` message (propagate HTTP 4xx/5xx from the gateway where helpful). The gateway returns proper codes and strict validation, so surface those.
* Optional: **Retry** uses the existing uploaded file; no re-upload.
* Add **dead-letter** tagging for repeated failures so they don’t loop.

## 10) Performance and cost controls

* Queue back-pressure: cap concurrent gateway calls per worker.
* File hash dedupe: if the same file shows up again, return the existing job or create a lightweight alias.
* Set a **per-file timeout** for processing to avoid zombie tasks.

## 11) Product polish (near-term)

* **Empty state** on `/queue` with a link back to upload.
* **Success metrics** box on `/queue`: total files, complete, failed, average processing time (rolling).
* Keep **Review** as a placeholder, but reserve the route (`/review/:id`) so the URL structure is stable.

## 12) Rollout in thin slices

1. **Jobs + redirect**: extend upload API to create jobs and redirect to `/queue` with a basic list (no worker yet).
2. **Worker hookup**: enqueue and call gateway; write XML; update statuses.
3. **Download**: enable `GET /api/jobs/:id/download`.
4. **UX polish**: polling stop conditions, disabled/enabled buttons, error copy.
5. **Reliability**: circuit breaker, dedupe by hash, retention, logs and metrics.

This keeps your current web structure intact (Next.js app router, upload route, local `uploads/`), matches the gateway’s contract, and adds just enough scaffolding to make the queue experience solid today with room to scale tomorrow. 
