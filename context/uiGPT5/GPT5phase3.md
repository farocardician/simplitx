
# Phase 3 — User Interface (v2, high‑level)

> Goal: Ship a clean queue page with live status, efficient polling, and a secure download endpoint. Keep it high‑level (no code), aligned with Phase 1–2 decisions.

## 1) Scope (Now)

### 1.1 Queue page (`/queue`)
- Shows the current session’s jobs (newest first) with: filename, size, mapping, status badge, created time, completed time (if any), and actions.
- Status badges: **Queued** (`uploaded|queued`), **Processing…**, **Ready**, **Failed`**.
- Actions:
  - **Download** enabled only when `status=complete`.
  - **Review** placeholder (disabled).
  - “Upload more” CTA back to the uploader.
- UX touches:
  - Relative time (“2m ago”), absolute on hover; local timezone rendering.
  - Rough time‑remaining hint (optional; hide for outliers).
  - Empty state when no jobs.
  - Mobile‑responsive; keyboard‑navigable; live region announces status changes.

### 1.2 Jobs list API — `GET /api/jobs`
- Ownership: filters by current session (or user when auth arrives).
- Incremental: supports `?since=<ISO>` using `updated_at` (server uses `>=`; clients de‑dupe ids).
- Response shape (no server formatting of sizes):
  - `jobs[]`: `id`, `filename`, `bytes`, `status`, `mapping`, timestamps (`created_at`, `updated_at`, `started_at?`, `completed_at?`), `error {code,message}?`, `can_download` (derived from status).
  - `active_count`: count of `uploaded|queued|processing` to stop polling.
  - `timestamp`: server ISO time to use as the next `since` cursor.
- Limits: default 50, max 200; order by `created_at DESC`.
- Performance: OK to add a **2s Redis cache** per session later (invalidate on status change or `updated_at` bump).

### 1.3 Download API — `GET /api/jobs/:id/download`
- Ownership check first; serve only via API (no direct file paths).
- States:
  - Not ready → `409` (`NOT_READY`)
  - Result missing/expired → `404` (`EXPIRED`)
  - Not owner → `403` (`FORBIDDEN`)
- Headers: `Content-Type: application/xml`, `Content-Disposition: attachment; filename="<original>-<jobId>.xml"`.
- Side effects (optional now, standard later): increment `download_count`, set `first_download_at`.

### 1.4 Optional Job detail API — `GET /api/jobs/:id`
- Only if UI needs single‑job fetch; otherwise list response is sufficient.

### 1.5 Polling strategy
- Interval 3–5s; exponential backoff with jitter on errors; pause when tab hidden; **stop when `active_count=0`**.
- First call without `since`, subsequent calls with last `timestamp`.
- UI merges updates by id; tolerates boundary duplicates.

---

## 2) Scope (Later / Deferred)
- Retry button for failed jobs (Phase 4).
- Review flow (`/review/:id`) (future).
- Filters and pagination (Phase 5).
- Download‑all (ZIP) (future).
- WebSockets/Server‑Sent Events (future; only if needed).

---

## 3) Touchpoints

### API
- `GET /api/jobs` (enhanced, incremental).
- `GET /api/jobs/:id` (optional).
- `GET /api/jobs/:id/download` (ownership‑scoped streaming).

### Database
- Read‑only queries aligned with indexes from Phase 1.
- Optional: `download_count`, `first_download_at` columns (safe to add now or later).

### UI
- Queue page + small components (status badge, file row, header).
- Accessibility: keyboard order, focus states, color contrast, ARIA live region.

---

## 4) Error and copy (consistent with Phase 1–2)
- `NOT_READY`: “Conversion not finished yet.”
- `EXPIRED`: “File was removed by retention. Re‑upload to regenerate.”
- `FORBIDDEN`: “This file isn’t yours.”
- `GW_4XX/5XX/TIMEOUT/IO_ERROR` (shown on failed rows as one‑liners).

---

## 5) Tests

### Unit
- Status badge → correct labels per status.
- Polling controller → stops when `active_count=0`; backs off on errors; pauses on tab hidden.

### Integration
- Live updates: job transitions queued → processing → ready reflected within a polling interval.
- Download flow: button disabled until ready; 409/403/404 paths handled.
- Ownership: cannot fetch or download another user’s job.

### Manual
- Upload → redirect to `/queue` and see new row.
- Multiple files appear and update independently.
- Empty state and mobile responsiveness verified.

---

## 6) Exit criteria
- Queue shows only **my** jobs; updates live; stops polling when idle.
- Downloads work only for completed jobs I own; errors return correct codes.
- Response uses incremental polling with `since`/`timestamp` and stays within limits.
- No server paths or secrets are exposed; filenames in `Content‑Disposition` are safe.
- Basic accessibility (keyboard + screen reader) validated.
