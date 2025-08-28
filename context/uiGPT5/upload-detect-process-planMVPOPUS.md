PLAN FOR: Drag & drop PDFs DB-driven detect
## MVP Phase Plan

### **Phase 1: Foundation - Multi-file Upload & Storage**

**Goal**: Replace single-file upload with multi-file system, establish core data models, maintain existing processing compatibility

**Scope Now**:
- Core Prisma models: `FileType`, `UploadSession`, `UploadFile`
- Multi-file upload API with deduplication
- File validation (type, size) from hardcoded rules
- Updated UI for multi-file cards
- Bridge to existing Job system

**Scope Later**: 
- DB-driven validation rules
- Detection system
- Template models

**Touchpoints**:
- **DB**: Add new tables via migration
- **API**: Modify `/api/upload` for multi-file, add `/api/upload-session`
- **UI**: Update `PDFDropzone.tsx`, create new `MultiFileUpload.tsx`
- **Storage**: Keep existing `/uploads` structure
- **Worker**: No changes

**Test Plan**:
- **Unit**: SHA256 dedup logic, file validation rules
- **Integration**: Upload 5 files → verify UploadFile records created → manually create Job → verify existing pipeline works
- **Manual**: Drag 10 PDFs (mixed valid/invalid), verify cards show validation errors, process valid ones

**Exit Criteria**:
- Can upload 10 PDFs simultaneously
- Duplicates detected and handled gracefully
- Invalid files blocked with clear errors
- Valid files can be manually processed through existing pipeline
- Existing queue page still works

---

### **Phase 2: Template Detection System**

**Goal**: Auto-detect document templates, enable manual override, maintain processing compatibility

**Scope Now**:
- `Client`, `DocType`, `Template` models with seeded PT Simon data
- Detection pipeline using s01/s02 on first 2 pages
- Basic keyword matching scorer
- Detection status in file cards
- Manual template selection dropdown

**Scope Later**:
- Regex patterns, layout hints
- Detection caching
- Progressive detection

**Touchpoints**:
- **DB**: Add template-related tables
- **API**: Add `/api/templates`, `/api/detect/{fileId}`, `PATCH /api/upload/{fileId}/template`
- **Worker**: New detection subprocess (Python scripts)
- **UI**: Add detection badge and dropdown to file cards
- **Storage**: Cache extracted text in `/tmp/detection`

**Test Plan**:
- **Unit**: Scorer with known keywords → expected scores
- **Integration**: Upload PT Simon invoice → verify auto-detection → change template → verify override persists
- **Manual**: Upload 5 different invoice types, verify correct detection or "Unmatched" status

**Exit Criteria**:
- PT Simon invoices auto-detect with >80% confidence
- Unknown PDFs marked as "Unmatched"
- Manual override works and persists
- Detection completes within 5 seconds per file

---

### **Phase 3: Integrated Processing Pipeline**

**Goal**: Connect detection results to processing, update queue page, complete end-to-end flow

**Scope Now**:
- `POST /api/process` using detected/selected templates
- Template → mappingKey resolution for worker compatibility
- Queue page shows Client/DocType columns
- `AuditLog` for template overrides

**Scope Later**:
- Batch ZIP downloads
- Reprocessing failed jobs
- Cost estimation

**Touchpoints**:
- **DB**: Update Job model with `uploadFileId`, `templateId`
- **API**: Create `/api/process` endpoint
- **Worker**: Pass templateId → mappingKey to existing pipeline
- **UI**: Add "Process All" button, update queue page columns
- **Storage**: Link UploadFile → Job → result path

**Test Plan**:
- **Unit**: Template → mappingKey resolution logic
- **Integration**: Upload → detect → process → download full cycle for 3 files
- **Manual**: Process 10 files, verify queue shows correct template info, all downloads work

**Exit Criteria**:
- Multi-file batch processes successfully
- Queue page shows template information
- Downloads work as before
- Audit log captures all template selections

---

### **Phase 4: Admin Controls & Production Readiness**

**Goal**: Enable template management without code changes, add observability, implement retry logic

**Scope Now**:
- Basic admin page for Template CRUD
- FileType management (enable/disable, adjust limits)
- Detection metrics endpoint
- Retry failed detections
- Session-based access control enforcement

**Scope Later**:
- JSON rule editor with schema validation
- Detection accuracy analytics
- A/B testing framework

**Touchpoints**:
- **DB**: Add indexes for metric queries
- **API**: Add `/api/admin/*` endpoints, `/api/metrics/detection`
- **UI**: Create `/admin` route with template table
- **Worker**: Add retry queue for failed detections
- **Storage**: Add cleanup cron for old files

**Test Plan**:
- **Unit**: Metric calculation functions
- **Integration**: Create template via admin → upload matching PDF → verify detection uses new template
- **Manual**: Admin creates new client/template, non-admin cannot access admin pages

**Exit Criteria**:
- Admin can add new template without deployment
- Metrics show detection success rate and P95 latency
- Failed detections retry once automatically
- 30-day session expiry works correctly

---

### **Implementation Order & Dependencies**

```
Phase 1 (3-4 days) → Phase 2 (4-5 days) → Phase 3 (2-3 days) → Phase 4 (3-4 days)
                                                                    ↓
                                                            Production MVP
                                                            (14-16 days total)
```

Each phase builds on the previous, but maintains backward compatibility. If development stalls, any completed phase represents a shippable improvement over the current system.