# Step 11 — Product polish

## 1) Upload flow niceties

* Keep drag-drop + picker; add “Upload more” on the queue page.
* Show a compact file list *before* POSTing (name, size, will be queued).
* Detect duplicates client-side (same name+size) and mark “Already uploaded” to avoid noise.
* Clear, human copy on limits: “PDF only, up to 50 MB each.”

## 2) Queue page clarity

* Status badges: Uploaded • Queued • Processing (spinner) • Ready • Failed.
* Default sort: newest first; optional filters: All, Active, Completed, Failed.
* Sticky header with counts: Total | Active | Completed | Failed.
* Row design: filename, size, mapping label, created/finished time, actions.
* Empty state with CTA back to upload.

## 3) Friendly errors (one-liners)

Map your error codes to short copy (no stack traces):

* NOT\_PDF: “Only PDFs are supported.”
* TOO\_LARGE: “File exceeds 50 MB limit.”
* GW\_4XX: “Couldn’t convert with this mapping.”
* GW\_5XX / GW\_TIMEOUT: “Converter is having an issue. We’ll retry.”
* IO\_ERROR: “Temporary storage issue. We’ll retry.”
* EXPIRED: “File was removed by retention. Re-upload to regenerate.”

## 4) Actions that feel right

* **Download**: enable only on Ready. Filename suggestion: `<original>-<jobId>.xml`.
* **Retry** (optional): inline link on Failed rows; disabled if source PDF is gone.
* **Download all** (optional): when multiple Ready, allow ZIP (server can stream a zip when you want).

## 5) Subtle progress cues

* Row-level timers: “Processing… \~30s” once you have a running average.
* Top bar progress: “3 of 7 active.”
* Toasts: “1 file ready to download.” Don’t spam; coalesce messages.

## 6) Review placeholder (future-proof)

* Link target reserved: `/review/:id` (disabled for now).
* When you turn it on: show the XML (read-only), a diff viewer for revisions, and a “Send correction” action that will later feed your LLM learning loop.

## 7) Notifications (optional)

* In-tab: keep polling with stop condition (no active jobs).
* Later: email or web push on completion (opt-in per session).

## 8) Accessibility

* Keyboard: tab through rows and actions; Enter to download.
* Live region (polite) announcing status changes.
* Color contrast AA; don’t rely on color alone for status (use icons/text).

## 9) Internationalization & time

* Render times in the user’s local timezone; store UTC in DB.
* Relative time for recent items (“2m ago”), absolute on hover.

## 10) Small quality-of-life bits

* Copy job ID button (helps support).
* Show mapping tag on each row (e.g., `pt_simon_invoice_v1`).
* “Re-upload” link on Expired rows that jumps to the uploader.
* Keep buttons steady (don’t shift layout when states change).

## 11) Admin/debug (hidden, but handy)

* `/admin/jobs/:id` (protected): raw job JSON, event timeline, file existence checks.
* Quick actions: “Recheck file,” “Force expire,” “Force retry.” (Use carefully in dev/staging.)

## 12) Metrics (tiny widget on queue)

* Counters: Completed | Failed | Avg processing time (rolling 20).
* Tooltip hint linking to your fuller dashboards.

## 13) Copy deck (microcopy you can paste)

* Queue header: “Your files are converting to XML.”
* Empty: “No files yet. Drop PDFs here to convert.”
* Ready row: “Ready — download XML”
* Failed row: “Failed — see details or retry”
* Expired row: “Expired — re-upload to regenerate”

## 14) Guardrails mirrored in UI

* Disable Upload when 3 active client uploads are in flight; show note “Processing 3 at a time.”
* If `/api/jobs` returns `active_count=0`, stop polling; resume on user action (new upload).

## 15) Acceptance checks (polish)

* After a batch upload, queue shows one row per file with correct badges and sizes.
* Polling stops automatically when all jobs are terminal; restarts if a new upload begins.
* Error rows show a single friendly line; Retry (if present) re-queues successfully.
* Download streams XML with a meaningful filename; “Download all” zips correctly when enabled.
* Nothing in the UI exposes server paths or stack traces.
* Keyboard and screen reader users can complete the whole journey.
