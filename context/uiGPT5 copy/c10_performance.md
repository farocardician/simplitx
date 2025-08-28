# Step 10: Performance & cost controls

# 1) Control work entering the system

* **Back-pressure at the worker**: cap concurrent calls to the gateway (start with 2–4 per worker). This prevents CPU spikes in PDF2JSON/JSON2XML and evens out latency.&#x20;
* **Queue depth guardrails**: if queued jobs > N (say 500), temporarily reject new uploads with a friendly message, or accept but don’t auto-dispatch until depth falls.
* **Per-session limits**: keep client upload concurrency at 3 (you already do), and optionally mirror a server-side per-session cap.&#x20;

# 2) Timeouts and cutoffs

* **Per-file processing timeout**: hard cap (e.g., 180s). Mark as `GW_TIMEOUT` and retry with backoff; don’t let zombies tie up leases.&#x20;
* **Circuit breaker**: if 5xx/timeouts breach a threshold, pause dispatch (hold in `queued`) until gateway health is green again. Saves compute and keeps UX honest.&#x20;

# 3) Do less work (dedupe and reuse)

* **Content-hash dedupe**: `(owner_session_id, sha256, mapping, bytes)` prevents reprocessing identical files; return the existing job or a lightweight alias. This lowers gateway CPU and disk churn. &#x20;
* **Skip rework on resume**: if `result_path` already exists when a worker resumes, treat as success and avoid a second gateway call.&#x20;

# 4) Make polling cheap

* **Stop conditions**: return `active_count` from `/api/jobs`; when it hits 0, the UI stops polling. Saves DB reads and bandwidth.&#x20;
* **Incremental fetch**: support `since=<ISO>` so the queue page only pulls changes. (Cursor paging only if the list gets big.)&#x20;

# 5) Keep DB fast (and inexpensive)

* **Indexes that match access patterns**: `(owner_session_id, created_at DESC)` and `(owner_session_id, status)` power the queue efficiently; `(status, created_at DESC)` helps workers.&#x20;
* **Short, simple transactions**: lease → process → complete/failed. Don’t hold locks while calling the gateway.&#x20;
* **Event retention**: keep `job_events` but purge or compact after 30–90 days so logs don’t balloon storage.&#x20;

# 6) Storage and bandwidth spend

* **Retention**: PDFs \~7 days; XML \~30 days or delete on first download. It controls disk growth without touching UX.&#x20;
* **Sharded paths** once volume grows (yy/mm/dd) to avoid huge directories. (Schema stays the same.)&#x20;
* **Download through API**: stream on demand; later, consider short-lived pre-signed URLs to push bandwidth to your object store if you move to S3.&#x20;

# 7) Right-size the gateway footprint

* **One public endpoint** (`/process` on 8002); PDF2JSON/JSON2XML stay internal. That minimizes exposed surface and keeps horizontal scaling simple.&#x20;
* **Health-gated startup**: rely on compose healthchecks so the gateway only accepts traffic when both internal services are ready.&#x20;

# 8) Concurrency knobs (practical defaults)

* **Worker concurrency**: start at 2–4 tasks per worker pod/process; raise gradually while watching gateway P95 latency and 5xx.&#x20;
* **Lease TTL**: 5–10 minutes with periodic extension during long PDFs; reduces duplicate work if a worker dies.&#x20;

# 9) UI cost hygiene

* **Client concurrency** capped at 3 uploads (already implemented). Keep progress events lean; avoid sending server paths back to the client. &#x20;
* **Mobile**: pause polling when the tab is hidden; resume on focus. (Pairs with stop-when-idle from `active_count`.)&#x20;

# 10) Observability to guard spend

* Track `queue_depth`, `jobs_failed_total{error_code}`, `gateway_latency_seconds` P95/P99, and disk bytes for `/uploads` and `/results`. Alert on spikes to intervene early.&#x20;
* Use job\_id as **correlation id** end-to-end so you can spot slow PDFs/mappings and throttle or block problematic sources.&#x20;

# 11) Scale path (when volume grows)

* **Horizontal scale**: add more workers behind the same Postgres; gateway remains a single public entry and scales independently.&#x20;
* **Thin slices rollout**: ship in layers (Jobs → Worker → Download → UX polish → Reliability) so you can measure each slice before scaling further.&#x20;

---

## Acceptance checks for Step 10

* With worker concurrency at 2–4, gateway P95 is stable and 5xx doesn’t spike under load.&#x20;
* Dedupe prevents repeat processing for identical uploads (same session, same mapping).&#x20;
* UI polling halts when `active_count=0`; incremental fetch reduces DB reads during long sessions.&#x20;
* Retention deletes old artifacts and keeps DB rows; download after expiry returns 404 with a clear message.&#x20;
* Circuit breaker pauses dispatch on gateway failures and resumes automatically on health.&#x20;
