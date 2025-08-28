# Go-live checklist

## A) Config & secrets

* [ ] `DATABASE_URL` set for prod (Postgres).
* [ ] `GATEWAY_URL` set to the internal URL.
* [ ] Worker knobs: `WORKER_CONCURRENCY`, `GATEWAY_TIMEOUT_MS`, `RETRY_MAX_ATTEMPTS`, `WORKER_LEASE_TTL_SEC`.
* [ ] Storage knobs: `PDF_TTL_DAYS`, `XML_TTL_DAYS`, `DELETE_XML_ON_FIRST_DOWNLOAD`.
* [ ] Mapping registry present and default mapping locked (e.g., `pt_simon_invoice_v1`).
* [ ] All env secrets stored in your secret manager, not in code or logs.

## B) Database & schema

* [ ] Prisma migrations generated and applied to prod.
* [ ] `jobs` table has required indexes (owner+status, owner+created\_at, status+created\_at).
* [ ] Status enum created and matches app states.
* [ ] Optional tables created if used: `job_events`, `job_artifacts`.
* [ ] Backup policy active and tested (restore from snapshot works).

## C) Infrastructure & networking

* [ ] Web, worker, and gateway are on the same private network.
* [ ] Only the gateway’s public endpoint is exposed externally.
* [ ] Health checks in place for web and gateway.
* [ ] Volumes mounted for `/app/uploads` and `/app/results` (or S3 configured).
* [ ] TLS on the public edge; HTTP only on the private network.

## D) Storage & retention

* [ ] Local folders exist and are writable, or S3 bucket and IAM are set.
* [ ] Atomic write path for XML (temp → rename).
* [ ] Daily cleanup job scheduled; won’t delete while a job is active.
* [ ] Disk alerts configured (soft/hard thresholds) if on local storage.

## E) Security guardrails

* [ ] Server rejects non-PDFs and >50 MB with clean JSON errors.
* [ ] Mapping allow-list enforced on the server.
* [ ] All file serving goes through `GET /api/jobs/:id/download` with ownership checks.
* [ ] Session cookie is httpOnly, Secure in prod, SameSite=Lax or Strict.
* [ ] Basic security headers set (CSP, nosniff, referrer policy, permissions policy).
* [ ] CORS locked to your origin.

## F) Observability & alerts

* [ ] Structured logs with `job_id` as correlation id across web, worker, and gateway.
* [ ] Dashboards: queue depth, active jobs by state, success/fail by error\_code, gateway latency P95/P99, storage bytes, cleanup activity.
* [ ] Alerts: gateway 5xx/timeout spike, stuck queue, disk pressure, cleanup stalled.

## G) Functional tests (manual, end-to-end)

* [ ] Upload 1 small PDF → job moves to Ready → XML downloads.
* [ ] Multi-upload (3+) → all show in queue; stop polling when active count hits 0.
* [ ] Download before Ready → 409 Not Ready.
* [ ] Retention path: after TTL cleanup, download → 404 Expired with friendly copy.
* [ ] Dedupe: upload the exact same PDF again (same session, same mapping) → reuses existing job (no reprocessing).
* [ ] Mapping label visible on each row.

## H) Failure drills (pre-launch)

* [ ] Non-PDF → 400 NOT\_PDF; UI shows one-line message.
* [ ] \>50 MB → 413 TOO\_LARGE.
* [ ] Bad mapping → 400/406 surfaced as GW\_4XX; no retries.
* [ ] Kill the gateway → breaker opens; jobs stay queued (or fail-fast if you chose that mode).
* [ ] Simulate gateway timeout → worker retries with backoff, caps at max attempts.
* [ ] Simulate worker crash mid-processing → lease expires, another worker resumes, no duplicate XML.
* [ ] IO write failure simulation → job marks IO\_ERROR, one retry, then failed.

## I) Load & latency check (lightweight)

* [ ] Batch of mixed PDFs (small, medium, large) at target concurrency.
* [ ] Watch gateway P95 latency and 5xx rate while tuning `WORKER_CONCURRENCY`.
* [ ] Confirm DB isn’t the bottleneck (short transactions, indexes working).

## J) UI polish (must-have)

* [ ] Clear limits copy: “PDF only, up to 50 MB each.”
* [ ] Status badges and single-line errors; no stack traces or server paths.
* [ ] Review button present but disabled; Download enables only on Ready.
* [ ] Empty state and “Upload more” from queue.
* [ ] Keyboard and screen reader path tested.

## K) Deployment & rollback

* [ ] Staging sign-off with the exact build you’ll ship.
* [ ] Deploy web, worker, gateway in this order: infra → DB → gateway → worker → web.
* [ ] Canary or low-traffic window for first production push.
* [ ] Rollback plan ready: previous images available; DB migrations are additive (or have down migrations planned).

## L) Runbook & ownership

* [ ] Short runbook: common errors, where to look, and restart steps.
* [ ] On-call owner and escalation path set for the first 48 hours.
* [ ] Issue templates for user-reported failures (include job id, timestamp, file size, mapping).

## M) Post-launch watch (T+24h / T+72h)

* [ ] T+24h: review failures by code, top PDFs by size, average processing time, any cleanup errors.
* [ ] T+72h: revisit worker concurrency, breaker thresholds, and retention knobs based on real usage.
* [ ] Decide whether to enable “Retry” on failed rows and “Download all” zip for Ready rows.

If you want, I can turn this into a one-page printable checklist or split it into tickets you can drop into your tracker.
