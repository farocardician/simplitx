**Phase 1 — Schema + Queue tweak** (no code).

---

## 1) Objectives

* Add a small reference table (**`productInformation`**) we control (keyed by vendor) to store approved `uomCode`, `optCode`, and `hsCode` per SKU/description for later reuse.
* Add an **Approved** indicator to jobs, surfaced on the **Queue** page, **without changing the current XML download behavior**. The existing download endpoints stream whatever is at `resultPath` and bulk-zip those files; this must remain intact. 

---

## 2) Steps

### Step A — Extend the database schema

**What to add**

* **New table: `productInformation`**

  * Columns (minimal MVP): `id` (uuid), `vendorId` (string), `sku` (nullable), `description` (text), `uomCode` (text), `optCode` (text), `hsCode` (text), `createdAt`, `updatedAt`.
  * Indexing/uniqueness (simple and practical):

    * Unique on `(vendorId, sku)` **when `sku` is not null**.
    * Unique on `(vendorId, description)` as a **secondary path** when `sku` is null.
  * Hint: In Postgres, `NULL` is not equal to `NULL`, so you can create **two** unique indexes—one for `(vendorId, sku)` and another for `(vendorId, description)`—and allow multiple nulls in `sku`. Keep it simple for MVP.

* **New table: `vendors`**

   * Purpose: hold a stable `vendorId` you can reference from other tables.
   * Minimal fields: `id` (primary key), `name` (as on invoice), `createdAt`, `updatedAt`.
   * Uniqueness: make `name` unique for now (keep it simple in MVP).
   * Seeding hint: read `seller.name` from services/pdf2json/results/simon/11-final.json to create vendor entries (e.g., `"PT Simon Elektrik-Indonesia"` appears in your sample).
   * Matching hint: do a **case-insensitive** match on `name` when looking up an existing vendor; if not found, insert a new one.  

* **New table: `uom`**

   * **Columns:**

      * `code` (unique, canonical ID, e.g., `UM.0021`)
      * `name` (display label, e.g., `Piece`)
      * `createdAt`, `updatedAt`
   * **Seed:** import from `uom.csv` (each row maps `code` → `name`).
   * **Alignment with productInformation:** `productInformation.uomCode` **stores `uom.code`** (not the name).
   * **FK:** add a foreign key from `productInformation.uomCode` → `uom.code` to keep data clean.
   * **Acceptance check:** you can query `uom` and see `code/name` pairs; e.g., `UM.0021 / Piece`.

* **Modify `Job` model** (web + worker Prisma schemas):

  * Add either `approved BOOLEAN DEFAULT false` **or** `approvedAt TIMESTAMP NULL`.
  * Start with a **boolean** for clarity on the Queue (“Yes/No”).
  * The current `Job` schema already includes paths like `resultPath`/`artifactPath`; we’re only adding the flag. 

**Guidance/Hints**

* Apply schema changes to **both** Prisma schemas (web and worker) so types stay aligned. 
* Run migrations and ensure the app starts cleanly in dev/prod docker profiles (no code changes yet).

---

### Step B — Surface “Approved” in the Queue (UI + API)

**What to change**

* **API** (Queue data source): include `approved` in the job selector so the UI can show it.
* **UI**: add a new **Approved** column with “Yes/No.” Do not alter or remove existing buttons.

**Guidance/Hints**

* Default display: if `approved` is `false` or `null`, show **No**.
* Keep styling consistent with existing status chips/buttons for a clean fit.

---

### Step C — Backfill & sanity checks

**What to do**

* Set existing rows in `jobs` to `approved = false` (or leave null and treat as “No” in the UI).
* Verify existing jobs still download their XML unchanged (the **same** file at `resultPath`).

**Guidance/Hints**

* Smoke test with a few PDFs already in the system; ensure:

  * The Queue loads and shows the **Approved** column.
  * XML and Artifact downloads behave exactly as before (buttons enabled rules unchanged).

---

### Step D — Seed some `productInformation` rows

**What to do**

* Insert example records for one vendor so you have realistic data for Phase 2’s read-only suggestions. Use items from services/pdf2json/results/simon/11-final.json

**Why**

* Lets you immediately see how lookups will behave in Phase 2. The lookup order will be: `(vendorId, sku)` then `(vendorId, description)`.

---

## 4) Risks & Considerations

* **Two lookup keys (SKU vs description):**
  Decide precedence now (SKU first, then description). This is already your intended policy for later phases.
* **Uniqueness & collisions:**
  Different vendors might reuse the same SKU/description. That’s why `vendorId` is part of the key. If duplicates appear, check your unique indexes and data entry flow.
* **Null handling:**
  Because `sku` is optional, make sure your unique/index strategy allows `sku = NULL` for description-only rows.
* **Backward compatibility:**
  The XML download flow must not change in Phase 1. Confirm the queue and endpoints behave exactly as before (only a new column is visible).

---

## 5) Expected Output

By the end of Phase 1 you should have:

1. **Database**

   * A new `productInformation` table (deployed and visible in your DB).
   * A new `vendors` table (deployed and visible in your DB).
   * `jobs.approved` (or `approvedAt`) added and defaulting to “not approved.”

2. **Queue UI**

   * A new **Approved** column that shows **Yes/No**.
   * All existing actions (Download XML / Download Artifact / Delete) work exactly like today.

3. **Endpoints**

   * No changes to download routes; they still stream from `resultPath` and bulk-zip as before. 

4. **Quick test checklist**

   * Create or pick a few completed jobs → Queue shows **Approved = No**.
   * Manually set one job’s `approved` to `true` in DB → Queue shows **Approved = Yes**.
   * Click **Download XML** for both “Yes” and “No” jobs → files download as before (no behavior change).
   * (Optional) A couple of `productInformation` rows exist to use in Phase 2 read-only suggestions.

That’s it. Phase 1 stays small and testable: one table, one job flag, one new column—no pipeline or download changes.
