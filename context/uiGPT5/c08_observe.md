# Step 8 — Observability
# What to capture (minimum viable)

**Structured logs (JSON)**

* **Web (API)**: request id, route, status, duration\_ms, bytes, mapping, session\_id, and **job\_id** when one exists. Your upload route and healthz are already defined; keep logging consistent there. 
* **Worker**: job\_id (as correlation id), state transition (queued→processing→complete/failed), gateway\_http\_status, gateway\_latency\_ms, attempt, error\_code, result\_bytes. Persist the important ones as **job\_events** as well.
* **Gateway**: request route and **X-Stage** pipeline steps (the gateway advertises stage tracking), status codes, size, latency.

**Metrics (Prometheus-style names just to be concrete)**

* **Counters**: `jobs_created_total`, `jobs_completed_total`, `jobs_failed_total{error_code=...}`, `uploads_total`, `upload_errors_total`.
* **Gauges**: `queue_depth`, `jobs_active` (uploaded|queued|processing), `disk_bytes_used{kind=uploads|results}`.
* **Histograms**: `api_request_duration_seconds{route=...}`, `gateway_latency_seconds`, `job_processing_duration_seconds`.
  These line up with your queue and worker contracts (job states, events, and durations).

**Health**

* **Web** already serves `GET /api/healthz` (use it for liveness checks).
* **Gateway + services** already have Docker healthchecks (compose shows them), and only the **gateway** is public on 8002. Keep relying on those. 

# Correlation: make every hop traceable

* Use **job\_id as the correlation id** end-to-end. Log it in web (on upload response), worker (all steps), and gateway (include as a header when you call it; gateway logs will then show it). Persist detailed steps in **job\_events.meta** (gateway URL, HTTP status, duration\_ms).
* Add `X-Request-Id` (or `X-Job-Id` when applicable) in API responses so you can connect browser reports to server logs later. (Pairs nicely with your upload hook progress flow.)

# Log shapes (keep it boring and consistent)

**Web (example fields)**

```
level, ts, route, method, status, duration_ms, session_id, job_id?, bytes?, mapping?
```

**Worker**

```
level, ts, job_id, event=queued|processing|complete|failed|retry, attempt, gateway_http_status?, gateway_latency_ms?, error_code?, result_bytes?
```

**Gateway**

```
level, ts, path=/process, accept, filetype, status, latency_ms, x_stage?
```

Gateway is the single `/process` endpoint, and it already validates Accept/filetype/mapping with the standard error codes (400/406/413/415/502), which should surface cleanly in logs and in your job’s error fields. 

# Dashboards you’ll actually use

**Ops view**

* Queue depth, jobs\_active by state, jobs\_failed\_total by error\_code, worker concurrency, **gateway 5xx rate** and latency P95.
* Service health cards for web/gateway (compose healthchecks already defined).

**Product view**

* Throughput (jobs/day), mapping mix, average processing time (start→complete), success rate. Your mapping is explicit (`pt_simon_invoice_v1` today), so slice by mapping.

**Storage view**

* Bytes in `/uploads` vs `/results`, items nearing TTL, deletions per day. This ties to your retention plan.

# Alerts (simple, useful thresholds)

* **Gateway unhealthy / 5xx**: >1% of `/process` requests over 5 minutes → page the worker owner. The gateway is the only exposed hop; catching its flakiness early matters.
* **Queue stuck**: `queue_depth > N` for 10 minutes while `gateway` health is OK → investigate worker leases or dead letters. Your lease/worker model supports this.
* **Failure spike**: `jobs_failed_total{error_code!="GW_4XX"}` increases >5% over 10 minutes.
* **Disk pressure**: disk free <10% under `/app/uploads` or `/app/results`.
* **Cleanup stalled**: no expirations processed in 24h even with expired artifacts.

# Where each signal comes from (wiring map)

* **Web**: log on upload start/end and return JSON; the route already returns structured info and prints a save line — switch to structured logs there.
* **Worker**: log before/after the gateway call (`GATEWAY_URL=http://gateway:8000` in compose), with durations; write a `job_event` on each state change. 
* **Gateway**: logs + **X-Stage** in headers (pipeline step hints) for PDF→JSON→XML; keep these visible in `make logs`. 

# SLOs (start simple)

* **Availability**: Web `/api/healthz` + Gateway `/process` ≥ 99.9% monthly (from healthchecks and status codes). 
* **Latency**: P95 `job_processing_duration_seconds` ≤ 30s for typical invoices; P99 ≤ 120s for large ones.
* **Quality**: `jobs_failed_total / jobs_completed_total` ≤ 2% excluding `GW_4XX`.

# Privacy and safety in logs

* Don’t log raw file paths or full filenames in production logs (store those in DB only). Your upload route currently prints server paths — swap that to a structured, truncated path or job\_id only.
* Do log sizes (bytes), mapping, and error\_code. Avoid PII in `error_message`.

# Operability checklist (Day 1)

* **Make commands**: you already have `make logs`; keep using that during dev to tail gateway logs. Add similar targets for web and worker.
* **Dashboards**: three panels (Ops/Product/Storage) with the metrics above.
* **Alerts**: the four bullets above wired to Slack/email.
* **Runbook**: short doc: “If Gateway 5xx spikes → check gateway health, then worker leases, then disk.”

# Acceptance checks for Step 8

* Every upload returns a response with an id, and the **same id** appears in web logs and worker logs for the end-to-end conversion.
* `/api/healthz` and compose healthchecks show green for web/gateway; failing one produces a clear, single alert. 
* Dashboard shows: queue depth, success/fail counts by error\_code, gateway P95 latency, and storage bytes for uploads/results.
* Trigger a synthetic failure (bad mapping or oversized file) and see: correct HTTP code, job marked `failed` with `error_code`, alert if threshold crossed.