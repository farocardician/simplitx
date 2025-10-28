**Scope**

1. Product Management page
2. Auto-enrichment on the Review page with thresholds
3. Staging → human approval → live
4. Audit logs and safe indexing

**Behavior**

* On the Review page, if an item only has a description, match it against the live catalog.
* Auto-fill when `score ≥ 0.80`.
* Below `0.80`, do nothing.
* If I enter values manually, save and process XML, and also create a draft product (goes to moderation).
* Drafts need human approval before becoming active and searchable.
* The live index only uses active records.

**Data (high level)**

* `products`: id, description, hs_code, type, uom, status=`active`, timestamps
* `product_aliases`: id, product_id, alias_description, status (`active`|`draft`), created_by, timestamps
* `product_drafts`: id, proposed fields, source_context (invoiceId, pdf_line_text), kind (`new_product`|`alias`), confidence_score, status (`draft`|`active`|`rejected`), timestamps
* `audit_logs`, `enrichment_events`

**Utilities**

* Normalizer, Matcher (tokenize, n-grams, alias support, scoring), Indexers
* Live index = active products + active aliases; Staging index = drafts

**Pages**

* Product Management: list, debounce search, filter, sort, create/edit/delete active products, inline edit, validation, undo delete
* Moderation Queue: view drafts, approve/edit-then-approve/reject; approval writes to `products` or `product_aliases`, logs audit, and refreshes the live index

**Testable Phases**

* Phase 1: Foundations (schema, config, matching)
* Phase 2: Review Page Enrichment (auto + draft capture)
* Phase 3: Product Management Page (active catalog CRUD)
* Phase 4: Moderation Queue (staging → active)

**Deliverables before code**

* Architecture outline, DB schema/migrations, API endpoints, indexing plan, UX flows, feature flags
* Acceptance checks: 0.7 doesn’t auto-fill at 0.8; manual entry creates a draft; drafts never used until approved; approval updates live index; CRUD is validated with clear feedback