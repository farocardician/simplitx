# Step 2 — Web API (detailed, no code)

## Design goals

* Predictable JSON envelopes and status codes.
* Works with your current upload flow (one XHR per file to `/api/upload`).
* Mirrors client/server PDF+50MB rules you already enforce. 
* Single source of truth = Postgres `jobs` table from Point 1.

---

## Authentication / scoping

* **Anonymous sessions** for now: set/read an `owner_session_id` httpOnly cookie and scope all listing/downloading to it.
* If you add auth later, also allow `user_id` and OR-scope `(user_id || owner_session_id)`.

---

## Error envelope (consistent everywhere)

```json
{ "error": { "code": "STRING_CODE", "message": "human readable one-liner" } }
```

Examples: `NOT_PDF`, `TOO_LARGE`, `GW_TIMEOUT`, `GW_4XX`, `GW_5XX`, `IO_ERROR`, `UNKNOWN` (from Point 1 taxonomy).

---

## Endpoints

### 1) `POST /api/upload`

Create a **Job** for a single PDF file (your client already posts one file per XHR). Returns immediately; background processing happens later.

**Request**

* `Content-Type: multipart/form-data`
* Fields:

  * `file`: PDF (<= 50MB, validated server-side).
  * `mapping` (optional, default `pt_simon_invoice_v1`)
  * `pretty` (optional, `0|1`) for downstream XML

**Responses**

* `200 OK` (created or deduped)

  ```json
  {
    "job": {
      "id": "uuid",
      "filename": "invoice.pdf",
      "bytes": 123456,
      "status": "uploaded",
      "created_at": "2025-08-26T04:15:00Z"
    },
    "deduped_from": null
  }
  ```

  If deduped to an existing completed job:

  ```json
  { "job": { "...": "..." }, "deduped_from": "uuid-of-canonical-job" }
  ```
* `400 Bad Request` → invalid form data / not a PDF. (Your route already returns 400 for non-PDF.)
* `413 Payload Too Large` → > 50MB. (You already do this.)
* `500 Internal Server Error` → disk/IO or unexpected exception.

**Notes**

* Save to `uploads/{jobId}.pdf`; keep server path in DB (not user filename). Your current handler writes to a local `uploads/` dir; keep that behavior but switch naming to jobId. 
* Compute `sha256` for dedupe; apply **per-owner** dedupe per Point 1.

---

### 2) `GET /api/jobs`

List jobs for the current session (queue page poller).

**Query params**

* `status` (optional): one of `uploaded,queued,processing,complete,failed`
* `limit` (default 50, max 200), `cursor` (opaque) for pagination
* `since` (optional ISO timestamp) for incremental polling (return jobs created/updated since this time)

**Response**

* `200 OK`

  ```json
  {
    "jobs": [
      {
        "id": "uuid",
        "filename": "invoice.pdf",
        "bytes": 123456,
        "status": "processing",
        "created_at": "...",
        "completed_at": null,
        "error": null,
        "can_download": false
      }
    ],
    "next_cursor": null,
    "active_count": 2
  }
  ```
* `active_count` helps the UI stop polling when 0 (no `uploaded|queued|processing` left). (Matches your queue-page plan.)

**Indexes supporting this**

* `(owner_session_id, created_at DESC)` and `(owner_session_id, status)` from Point 1.

---

### 3) `GET /api/jobs/:id`

Detail view for a job (used by queue rows or a future review page).

**Response**

* `200 OK`

  ```json
  {
    "job": {
      "id": "uuid",
      "filename": "invoice.pdf",
      "bytes": 123456,
      "status": "complete",
      "created_at": "...",
      "queued_at": "...",
      "started_at": "...",
      "completed_at": "...",
      "error": null
    }
  }
  ```
* `403 Forbidden` if not owned by the current session.
* `404 Not Found` if no such job.

---

### 4) `GET /api/jobs/:id/download`

Stream the XML result when ready.

**Behavior**

* Only if `status=complete` and file exists; otherwise `409 Conflict` (not ready) or `404` (gone/expired).
* `Content-Type: application/xml`
* Optional short-lived **signed token** as `?token=...` for shareable links later.

**Security**

* Never serve from raw path; verify ownership and stream from controlled storage (per Point 1 security).

---

### 5) (Later) `POST /api/jobs/:id/retry`

* Clears `error_*`, re-queues the job if the original PDF is still present.
* `409 Conflict` if job is not in `failed`.

---

## Server → Worker contract (triggered by upload)

* After `POST /api/upload` returns, enqueue a background task:

  * Input: `job_id`, `mapping`, `pretty`.
  * Worker calls **Gateway** `POST /process` with `Accept: application/xml` (or JSON in future), per your gateway contract (port **8002**, single endpoint). 
  * On success: write `results/{jobId}.xml`, set `status=complete`.
  * On error/timeout: set `status=failed`, fill `error_code/message` (mirror gateway’s HTTP codes: 400/406/413/415/502).

---

## Status codes matrix (quick reference)

| Endpoint                    | 200/201     | 400                    | 403           | 404 | 409           | 413     | 500      |
| --------------------------- | ----------- | ---------------------- | ------------- | --- | ------------- | ------- | -------- |
| POST /api/upload            | ✓           | invalid form / not PDF | –             | –   | –             | ✓ >50MB | ✓        |
| GET /api/jobs               | ✓           | –                      | –             | –   | –             | –       | ✓ (rare) |
| GET /api/jobs/\:id          | ✓           | –                      | ✓ (not owner) | ✓   | –             | –       | ✓ (rare) |
| GET /api/jobs/\:id/download | ✓ (streams) | –                      | ✓             | ✓   | ✓ (not ready) | –       | ✓        |
| POST /api/jobs/\:id/retry   | ✓           | –                      | ✓             | ✓   | ✓ (bad state) | –       | ✓        |

---

## Validation rules (mirror client + route.ts)

* Only PDFs allowed; reject others. (Your route already does this.)
* 50MB limit with `413`. (Already in your route.)
* Friendly JSON errors; don’t leak server paths or stack traces. (Your current handler shapes JSON already.)

---

## Idempotency & dedupe

* Compute `sha256` on upload and apply **per-owner** dedupe:

  * If a matching **complete** job exists, respond `200` with `deduped_from`.
  * If a matching job is **in progress**, return that job’s id and status.
* Optional header: `Idempotency-Key` (store against job to guard retries on flaky networks).

---

## Pagination & polling strategy

* Use `since` for incremental polling and `active_count` to stop polling when 0.
* Support `cursor` pagination for the jobs list if you expect many rows.

---

## Observability

* Include `x-request-id`/`correlation_id` (job id works) in responses so logs tie together (upload → queue → worker → download). (Matches your observability plan.)

---

## Fit with your current code

* Client: already posts to `/api/upload` via XHR and handles progress. Keep that.
* Server: current `route.ts` writes to `uploads/`, validates PDF + 50MB, and returns JSON—extend it to create a `jobs` row and return `{ job }`. 
* Gateway: single public endpoint `:8002/process`—worker will call this for PDF→XML based on `Accept`/`mapping`.

---

### Acceptance checks for Point 2

* Uploading a valid PDF returns `{ job: {...} }` immediately with `status="uploaded"`.
* `/api/jobs` returns only **my** jobs, newest first, with `active_count`.
* `/api/jobs/:id/download` streams XML only when `status=complete`; otherwise 409/404.
* Errors follow the shared envelope with correct HTTP codes.