# Step 4 — Queue page (UX, data, and behavior)

## Purpose

Show every uploaded PDF as a **Job** with a live status, one row per file. Actions: **Review** (placeholder) and **Download** (XML when complete). This builds on your current upload flow (XHR to `/api/upload`) and the Jobs source of truth. 

---

## Data it depends on (from Step 2)

* `GET /api/jobs` returns: array of jobs (id, filename, bytes, status, created\_at, completed\_at, error), `next_cursor` (optional), and `active_count` so the UI knows when to stop polling. Sort newest first.
* `GET /api/jobs/:id` for details if you open a future drawer.
* `GET /api/jobs/:id/download` for XML when `status=complete`. Enforce ownership on the server; UI never accesses raw file paths.

---

## When users land here

**Redirect to `/queue` after upload**. The page starts polling and renders rows immediately. Button states: **Review** disabled; **Download** disabled until `complete`. If a job fails, show a short error line from `error_message`. This matches your high-level plan.

---

## Polling model (simple now, SSE-ready later)

* **Interval**: every 3–5s call `GET /api/jobs`. Stop when `active_count` is `0` (no `uploaded|queued|processing` left).
* **Incremental**: optionally send `since=<lastSeenISO>` to cut payloads if the endpoint supports it. Pagination via `cursor` only if you have lots of history.
* **Backoff**: if nothing changed for \~30s, back off to every 10s; return to 3–5s if any status flips.
* **Tab visibility**: pause polling when the tab is hidden; resume on focus (keeps costs down).

(Indexes from Step 1 support this: owner+status and owner+created\_at.)

---

## Layout and components

**Header**

* Title + small “Upload more” button that routes back to the existing drag-drop page. Your upload stack already handles PDF-only, 50MB, and 3 concurrent uploads. 

**Jobs list (desktop)**

* Columns: Filename • Size • Status • Started/Completed (as available) • Actions.
* **Status badges**: uploaded, queued, processing (spinner), complete (green), failed (red). These align with the state machine we defined.
* **Actions**:

  * **Review**: present but disabled (planned route: `/review/:id`).
  * **Download**: enabled only when `status=complete`, links to `GET /api/jobs/:id/download`.

**Jobs list (mobile)**

* Stack as cards: top line = filename + size; second line = status + timestamp; third line = action buttons. Your UI guidance already targets mobile-friendly, accessible interactions.

**Empty state**

* Message + “Upload files” CTA. (You called this out in product polish.)

---

## States and copy

**Active states**

* **uploaded**: “Queued” badge (server acknowledged the job).
* **queued**: “Waiting to process” with subtle clock icon.
* **processing**: spinner + “Converting to XML…”
* **complete**: “Ready” + Download button enabled.
* **failed**: “Failed” + one-line `error_message`. Map codes to friendly copy (see error taxonomy).

**Edge states**

* **Deduped**: If the server returns `deduped_from`, show a “Reused result” chip and keep Download enabled once that canonical job is complete. (This can be a column hint, not a separate status.)
* **Expired**: If retention removes files, show “Expired — reupload to regenerate” and disable Download. (Retention is defined in your storage section.)

**Error taxonomy → UI text**

* `NOT_PDF`, `TOO_LARGE` (client mirrors these rules), `GW_4XX`, `GW_5XX`, `GW_TIMEOUT`, `IO_ERROR`, `UNKNOWN`. Keep the short server message; no stack traces. 

---

## Sorting, filtering, and paging

* **Default sort**: newest first (created\_at desc).
* **Filter chips**: All, Active, Completed, Failed (optional).
* **Paging**: Cursor-based if you exceed \~100 rows; otherwise keep it simple.
* DB indexes for “my jobs newest-first” are already specified.

---

## Actions detail

**Download**

* Hitting `GET /api/jobs/:id/download` streams XML (`application/xml`). If the server uses short-lived tokens later, add `?token=…` transparently. Only the API serves files; never use raw paths.

**Review (placeholder)**

* Disabled for now, but reserve `/review/:id` so links won’t change when you activate it.

**Retry (optional, future)**

* If a row is `failed`, you can add a small “Retry” link that calls `POST /api/jobs/:id/retry`. It reuses the stored PDF (no re-upload).

---

## How it fits your existing client

* You already upload via XHR to `/api/upload` with progress and a 3-at-a-time cap. After upload completes, redirect here. Keep that flow; the queue page is read-only. 

---

## Accessibility and responsiveness

* **Keyboard**: all actions are reachable; focus rings visible.
* **ARIA**: role=table or list with status live-region for changes (polite).
* **Mobile**: touch-friendly targets and stacked layout (you already follow mobile-first). 

---

## Observability hooks

* Include the **job id** on each row and in any client logs to match server logs (upload → queue → worker → download). A simple “last updated” timestamp per row helps debug slow polls.

---

## Nice extras (non-blocking)

* **Metrics panel** (small widget): total files in list; counts by status; average processing time from `started_at`→`completed_at`. You already flagged this in polish.
* **Inline file size**: reuse your `formatBytes()` util for display.
* **Mapping label**: show the mapping used (e.g., `pt_simon_invoice_v1`) if present. The gateway requires mapping for XML paths.

---

## Edge cases to handle

* **404** on download (expired): show toast and disable the button on that row. Retention is expected.
* **Gateway down → many failures**: rows move to `failed` with a clear code; polling continues so users see if a later retry succeeds. Your error handling plan already covers this.
* **Duplicate upload in same session**: row can show a “Duplicate of …” badge; do not double-process; use the dedupe hint from the response.

---

## Acceptance checks for Step 4

* After uploading multiple PDFs, `/queue` lists **each** file as a row with the right status and size.
* Polling stops when `active_count=0` and all rows are `complete` or `failed`.
* **Download** enables only on `complete` and streams XML; **Review** stays disabled.
* Failures show a one-line message from the server’s `error_message` using the shared taxonomy.
* Empty state appears if there are no jobs, with a clear link back to upload.