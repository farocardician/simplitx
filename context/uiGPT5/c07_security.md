# Step 7 — Security & guardrails

## 1) Request & input validation (server-first)

* **PDF-only + 50 MB** enforced on the server (not just client). Reject with clear JSON errors and correct status codes (`400` / `413`). Your current upload route already does this — keep it as the baseline and mirror it across the new API.  &#x20;
* **Mapping allow-list**: accept only known `mapping` values (e.g., `pt_simon_invoice_v1`) and fail fast on unknowns (`400`) before calling the gateway. The gateway itself validates Accept/filetype/mapping and returns `406/400/415/413/502`; surface those cleanly. &#x20;
* **Path safety**: never use user filenames as paths; normalize and write only under `uploads/` and `results/`. Your docs already call out traversal protection — keep it strict. &#x20;

## 2) Ownership & access control

* **Anonymous session scoping**: set an `owner_session_id` httpOnly cookie (SameSite=Lax/Strict). All list/detail/download endpoints must filter by `owner_session_id` (and `user_id` later). This is already the model in your jobs spec. &#x20;
* **Download gate**: stream XML only via `GET /api/jobs/:id/download` after ownership check; never serve files from raw paths or public folders.&#x20;
* **Short-lived tokens (optional)**: add a signed `?token=…` for shareable links, expiring in \~1–5 minutes. It’s already in your plan.&#x20;

## 3) Network & service isolation

* **Expose only the gateway on 8002**; keep PDF2JSON and JSON2XML internal. The project summary already follows this pattern — keep the worker talking to services on the internal network. &#x20;
* **Health checks**: keep `GET /api/healthz` and use service health in compose to avoid race conditions on boot. &#x20;

## 4) Rate limits & DoS protection

* **Per-session upload concurrency**: cap at 3 client-side (you already do) and consider a server-side cap per session/IP to match.&#x20;
* **Size & count guards**: reject combined active uploads over a threshold; return a friendly error. Client already exposes human-readable sizes.&#x20;
* **Gateway back-pressure**: control worker concurrency and use a circuit breaker on repeated 5xx/timeouts so queues don’t explode. This is in your plan; keep it strict.&#x20;

## 5) Storage safety (local now, S3 later)

* **Non-public storage**: files under `/app/uploads` and `/app/results`, never in the web root; API streams after checks.&#x20;
* **Atomic writes** for results (temp → rename), and verify file exists & size > 0 before marking `complete`. (Matches your integrity checklist in storage step.)
* **Retention**: PDFs \~7 days, XML \~30 days (or delete on first download). On cleanup, delete file, null the path, add a `job_event: expired`. UI should show “Expired — re-upload to regenerate.” &#x20;

## 6) Error taxonomy & safe messages

* Use your standard codes: `NOT_PDF`, `TOO_LARGE`, `GW_4XX`, `GW_5XX`, `GW_TIMEOUT`, `IO_ERROR`, `UNKNOWN`. Keep messages one-liners; don’t leak stack traces or server paths.&#x20;
* Your upload route already returns structured JSON. Keep that envelope across all endpoints.&#x20;

## 7) Worker safety & idempotency

* **Leases**: `leased_by` + `lease_expires_at`; if a worker dies, another can take over safely. Log every transition.&#x20;
* **No double processing**: if `result_path` exists, skip re-work unless it’s an explicit retry. Dedupe on `(owner_session_id, sha256, mapping, bytes)` to avoid duplicate jobs.&#x20;

## 8) Transport & headers

* **HTTPS everywhere** in prod.
* **CORS**: same-origin only (disable cross-origin by default).
* **Security headers** (via Next): `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (disable unneeded features), and a sane **CSP**.
* **Cookies**: `HttpOnly`, `Secure` in prod, `SameSite=Lax/Strict`.

## 9) Secrets & logging hygiene

* Keep `DATABASE_URL` and any S3 creds only in env/secret stores; never log them.
* **Log privacy**: include `job_id`, bytes, timing, mapping; exclude filenames, raw paths, or tokens. Your observability plan already suggests correlation IDs — use the job id.&#x20;

## 10) Gateway-specific guardrails

* **Strict Accept routing**: the gateway already rejects invalid file/Accept combos with `406`. Treat those as user errors (`GW_4XX`) and show clear copy.&#x20;
* **50 MB ceiling**: aligns with gateway validation; keep upload route in lock-step to avoid surprises.&#x20;
* **Mapping filename safety**: JSON2XML validates mapping filenames against traversal — still keep your own allow-list.&#x20;

## 11) UI safety touches

* Show only **friendly error lines** from `error_message`; map codes to human copy on the queue page. Don’t show stack traces/paths.&#x20;
* Disable **Download** until `status=complete`; if `404` on download (expired), toast + disable button.&#x20;

## 12) Acceptance checks (security)

* Upload a non-PDF → `400` with `NOT_PDF`. Upload >50 MB → `413` with `TOO_LARGE`. (Server-side.)&#x20;
* Try to `GET /api/jobs/:id` for someone else’s job → `403`.
* Try to download before complete → `409`; after retention cleanup → `404`. (And UI reflects it.)&#x20;
* Mapping not in allow-list → `400` (no gateway call).
* Worker crash mid-run → lease expires; another worker finishes; no duplicate XML.&#x20;
