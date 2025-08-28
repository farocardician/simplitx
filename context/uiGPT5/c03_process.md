# Step 3 — Background processing (worker ↔ gateway)

## Goal

Take a queued job, call the Gateway’s single endpoint to do **PDF → XML**, save the result, and update the job cleanly, with retries and safe concurrency. The same scaffolding later supports **PDF → JSON → LLM → XML** without redoing the plumbing. The Gateway already exposes **`:8002/process`** and supports **PDF→XML** with `Accept: application/xml` and a `mapping`. 

---

## Architecture shape

**Add a dedicated worker service** (separate container) that:

* Connects to Postgres (same `DATABASE_URL` as web).
* Shares the uploads/results volume with web (`./uploads` → `/app/uploads`).
* Talks to Gateway via internal network URL (e.g. `http://gateway:8000/process`). Your compose already exposes Gateway and internal URLs.

Why a separate service: keeps web fast and predictable, and you already planned for “Worker Services” in the context docs.

---

## The worker’s responsibilities

1. **Pick work**

   * Select `status='queued'` jobs with no lease or expired lease, oldest first, limit N.
   * In one transaction, set `leased_by`, `lease_expires_at`, set `status='processing'`, set `started_at`. (Matches your leasing contract.)

2. **Prepare inputs**

   * Resolve the job’s `upload_path` to read `uploads/{jobId}.pdf`.
   * Read `mapping` (default `pt_simon_invoice_v1`) and `pretty` flags. Paths for uploads/results are already defined in your plan. 

3. **Call Gateway**

   * `POST` to `http://gateway:8000/process` with `file=@…pdf;type=application/pdf`, `mapping=…`, `pretty=1`, header `Accept: application/xml`.
   * Respect gateway rules and errors (400/406/413/415/502). The gateway routes requests based on `Accept` and file type. 

4. **Write outputs**

   * Save XML to `results/{jobId}.xml` and set `result_path`.
   * Set `status='complete'`, `completed_at`.

5. **Handle failures**

   * Map to your error taxonomy: `GW_4XX`, `GW_5XX`, `GW_TIMEOUT`, `IO_ERROR`, etc. Set `status='failed'`, `error_code`, `error_message`, `failed_at`.

6. **Emit events (optional but helpful)**

   * `job_events`: `processing`, `complete` or `failed` with `meta` like HTTP status, duration\_ms, and gateway URL.

---

## Worker concurrency and back-pressure

* **Max concurrent jobs** per worker process (start with CPU count or 2–4).
* **Lease TTL**: 5–10 minutes. Extend lease periodically while processing. If the worker crashes, leases expire and another worker can take the job safely.
* **Rate limits**: cap concurrent Gateway calls to avoid starving other services. You already called out queue back-pressure controls.

---

## Timeouts, retries, and dead-letters

* **HTTP timeout** to Gateway: start with 120–180s (big multi-page PDFs).
* **Retries**: exponential backoff on `GW_5XX` or `GW_TIMEOUT` (e.g., 3 attempts max). Increment `attempt_count`, set `last_attempt_at`.
* **No retry** on `GW_4XX` (bad mapping, invalid combo).
* **Dead-letter**: if attempts exceed max or repeated timeouts, mark `failed` and tag as dead-letter to prevent loops. You already planned this.

---

## Idempotency

* If `result_path` exists and file is present, don’t reprocess unless explicitly retried.
* Use `sha256 + mapping + bytes` for dedupe at job creation. If another identical job appears during processing, return the in-progress or completed job instead of reprocessing.

---

## Circuit breaker

* Track rolling failures to Gateway (e.g., 5xx or timeouts).
* If failures breach a threshold in a sliding window, **pause new dispatches** and fail fast with a friendly `GW_5XX` message so the queue doesn’t grow unbounded. This matches your plan to add a breaker.

---

## File and path handling

* Read only from controlled `uploads/` and write to `results/`.
* Never trust `original_filename`. Persist and serve paths from DB. Your web and context already use `uploads/` and define this layout. 

---

## Config you’ll set (env)

* `DATABASE_URL` (same as web, Docker Option 2).
* `GATEWAY_URL=http://gateway:8000` (internal). Your compose already sets a similar var for web. Add it for worker too.
* `WORKER_CONCURRENCY` (e.g., 4).
* `WORKER_LEASE_TTL_SEC` (e.g., 600).
* `GATEWAY_TIMEOUT_MS` (e.g., 180000).
* `RETRY_MAX_ATTEMPTS` (e.g., 3), `RETRY_BACKOFF_MS` (e.g., 5000→20000).

---

## Interaction flow (single job)

1. **Pick** `queued` job with exp/nulled lease; atomically mark `processing`, set lease.
2. **Call Gateway** `/process` with `Accept: application/xml` and `mapping`. Gateway routes PDF→XML across internal services.
3. **Save XML**, update job `complete`.
4. Or **map error**, update job `failed`.
5. **Release** lease (implicit when status changes).
6. **Emit event** for observability.

---

## Observability and logs

* Always log with the **job id** as `correlation_id`.
* Log major transitions with timings: queued age, processing duration, Gateway latency. This lines up with your earlier observability plan.
* Optional counters: success, failed, avg duration, retries.

---

## Health checks

* Simple **worker liveness** endpoint or periodic “I’m alive” log.
* **Gateway health probe** before dispatch. If unhealthy, skip claiming jobs and flip the circuit breaker. Your Gateway already has health checks in compose.

---

## Security notes

* Never stream XML back from worker. Only web serves downloads via `GET /api/jobs/:id/download` after ownership checks. You’ve documented this rule already.
* Keep mapping names validated. Gateway rejects invalid combinations and enforces size and type.

---

## Compose changes (at a glance)

Add a `worker` service that:

* Uses the same codebase image as web (Node) or a minimal Node image.
* Mounts `./services/web:/app` and `./uploads:/app/uploads` (same as web).
* Depends on `gateway` health.
* Has env: `DATABASE_URL`, `GATEWAY_URL`, and the worker knobs above.

---

## Future-proofing for LLM path

When you add LLM later, the worker can branch per job “mode”:

* **Mode A (today)**: `PDF → XML` via `Accept: application/xml`.
* **Mode B (later)**:

  1. `PDF → JSON` (`Accept: application/json`)
  2. Run LLM validation/extraction, write `llm_checks` row with confidence
  3. If confidence is high, `JSON → XML` with mapping; else keep LLM-extracted XML
  4. Set job `complete`, and save artifacts/events for review

The Gateway already supports both `PDF→JSON` and `JSON→XML` as separate calls and a single-call `PDF→XML`, so you won’t have to touch web or queue contracts when you add the LLM branch. 

---

## Acceptance checks for Step 3

* With at least one `queued` job, starting the worker results in:

  * Job transitions to `processing`, then `complete` with a non-empty `result_path`, or `failed` with `error_code` and `error_message`.
* If Gateway is down, jobs move to `failed` with `GW_5XX` and the circuit breaker pauses new dispatches.
* Retrying a `failed` job (manually) re-queues it and respects `attempt_count` caps.
* If the worker crashes mid-run, the lease expires and another worker can pick the job; no duplicate XML is produced.
* The queue page shows status changes via existing `/api/jobs` polling.
