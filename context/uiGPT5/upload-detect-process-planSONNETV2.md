# Enhanced Drag & Drop PDF Processing Flow - Implementation Plan

## Where We Are Now (Current State)

### Current Architecture
We have a **working PDF processing MVP** with these components:

**Frontend (Next.js 14 + React)**
- Home page (`/`) with existing `PDFDropzone` component for drag & drop
- Queue page (`/queue`) with real-time polling and job status display
- Hardcoded PDF validation (only `.pdf` files, 50MB limit)
- Manual process: user uploads → immediately creates Job → worker processes → user downloads

**Backend Services**
- **Web service**: Next.js API routes with PostgreSQL + Prisma
- **Gateway service**: Routes requests to processing services
- **PDF2JSON service**: 10-stage pipeline (s01_tokenizer through s10_parser)  
- **JSON2XML service**: Converts structured data to XML output
- **Worker service**: Polls database for jobs, orchestrates processing pipeline

**Current Database Schema**
```sql
Job {
  id, ownerSessionId, originalFilename, contentType, bytes, sha256
  mapping (hardcoded: "pt_simon_invoice_v1")
  status (uploaded → queued → processing → complete/failed)
  file paths, timestamps, error handling, download tracking
}
```

**Current User Flow**
1. User drops PDF in dropzone → immediate upload
2. Upload API creates Job record, saves file, sets status to 'queued'  
3. Worker picks up job, processes through pdf2json → json2xml pipeline
4. User monitors progress on queue page, downloads when complete

### Current Limitations
- **Hardcoded template** (`pt_simon_invoice_v1` for all files)
- **No client detection** - all files treated as "PT Simon invoices"
- **Fixed file type rules** - only PDFs allowed, hardcoded in frontend
- **No template matching** - same processing pipeline for all documents
- **Single-template system** - can't handle different clients or document types

---

# Revised Drag & Drop PDF Processing Flow Implementation Plan

## Overview
Transform the current hardcoded system into a **database-driven detection system**: **PDFs → DB-driven Detection on Upload → Process via existing pipeline → Download**. Detection happens during upload, Jobs remain focused on processing only.

## Phase 1: Drop & Upload
**Goal**: Multi-file drag & drop with DB-driven validation and upload-time detection

### Database Schema Updates
```sql
-- New Models
FileType {
  id, mimeType, extensions[], label, enabled, maxSizeMB
  createdAt, updatedAt
}

Template {
  id, name, clientName, docTypeName
  matchRules (JSONB), threshold, priority, enabled
  allowProcessWhenUnmatched (Boolean)
  createdAt, updatedAt  
}

Upload {
  id, ownerSessionId, originalFilename, fileTypeId
  detectionResults (JSONB), selectedTemplateId
  createdAt, updatedAt
}

-- Job Model Changes (minimal)
Job {
  // Existing fields unchanged
  uploadId (references Upload.id)
  templateId (references Template.id) -- from detection
  // Remove hardcoded mapping field eventually
}
```

### Detection Architecture
- **Upload-time detection**: Text extraction + template matching during upload
- **Template scoring**: JSONB `matchRules` with weighted scoring system
- **Top-N storage**: Store all candidate scores for tuning
- **Configurable thresholds**: Per-template confidence thresholds
- **Unmatched handling**: `allowProcessWhenUnmatched` flag controls processing

### API Endpoints
```typescript
// New endpoints
GET /api/file-types -> {allowedTypes: FileType[], maxSizeMB}
POST /api/upload -> {upload: Upload, detectionResults, canProcess}

// Modified endpoint  
POST /api/process -> {uploadId, templateId?} // Creates Job from Upload
```

### Frontend Changes
- **Enhanced PDFDropzone**: Fetch allowed types from database
- **Detection display**: Show client/doc type/confidence immediately after upload
- **Template override**: Dropdown for manual selection when unmatched
- **Process buttons**: Per-file and batch processing

**Deliverable**: Users drag & drop multiple PDFs, see detection results immediately

## Phase 2: Detect & Preview (Week 2)
**Goal**: Rich detection preview with template matching and override capabilities

### Detection Engine Implementation
```python
# Utilize existing processing stages
s01_tokenizer.py -> Extract text tokens from PDF
s02_normalizer.py -> Clean and normalize text

# New template matching logic
Template.matchRules = {
  "keywords": {"PT SIMON": 10, "INVOICE": 5, "FAKTUR": 8},
  "patterns": {"INV-\\d{4}-\\d{6}": 12},
  "structure": {"has_table": 3, "page_count_range": [1,3]}
}

# Scoring algorithm
score = sum(rule_weight for matched_rule)
confidence = score / max_possible_score
match = score >= template.threshold
```

### UI Enhancement Details
```typescript
// Enhanced file display
interface DetectionResult {
  topCandidates: Array<{
    templateId: string
    clientName: string  
    docTypeName: string
    score: number
    confidence: number
    matched: boolean
  }>
  selectedTemplate?: {
    id: string
    clientName: string
    docTypeName: string
    confidence: number
  }
  canProcess: boolean
  unmatchedReason?: string
}
```

### File Card Enhancements
- **Detection results**: Client name, Document type, File type, Confidence score
- **Candidate list**: Show top-3 matches with scores (for debugging)
- **Inline errors**: "Could not match template - please select manually"
- **Override dropdown**: Manual template selection for unmatched files
- **Process control**: Enable/disable based on `allowProcessWhenUnmatched`

**Deliverable**: Rich detection preview with debugging info and manual override

## Phase 3: Process & Queue (Week 3)  
**Goal**: Process button creates Jobs using existing pipeline, no pipeline changes

### Processing Flow Updates
```typescript
// New processing endpoint
POST /api/process {
  uploadIds: string[]
  templateOverrides?: {uploadId: string, templateId: string}[]
}

// Creates Job records
Job.create({
  uploadId: upload.id,
  templateId: selectedTemplate.id,
  mapping: selectedTemplate.name, // Maps to existing worker logic
  // All other existing fields unchanged
})
```

### Worker Integration
- **No worker changes**: Jobs still contain `mapping` field for existing pipeline
- **Template reference**: Job.templateId for audit/reporting only
- **Upload reference**: Job.uploadId links back to detection data
- **Existing pipeline**: pdf2json → json2xml → result storage unchanged

### UI Process Controls
- **Per-file processing**: "Process" button on each file card
- **Batch processing**: "Process All Valid" for matched files
- **Status linking**: After process, redirect to existing `/queue` page
- **Error handling**: Show processing errors inline, fallback to queue page

**Deliverable**: Complete upload → detect → process → monitor → download flow

## Technical Architecture Deep Dive

### Upload-Centric Detection Model
```
Current: File → Job Creation → Processing → Result
New:     File → Upload + Detection → [User Choice] → Job Creation → Processing → Result
```

### Template Matching Engine
```javascript
// JSONB matchRules structure
{
  "keywords": {
    "required": {"PT SIMON": 15, "INVOICE": 10},
    "optional": {"FAKTUR": 5, "TAGIHAN": 5}
  },
  "patterns": {
    "invoice_number": {"regex": "INV-\\d{4}-\\d{6}", "weight": 12},
    "date_format": {"regex": "\\d{2}/\\d{2}/\\d{4}", "weight": 3}
  },
  "structure": {
    "page_count": {"min": 1, "max": 5, "weight": 2},
    "has_tables": {"required": true, "weight": 8}
  }
}

// Scoring algorithm  
total_score = sum(matched_rule_weights)
confidence = total_score / template.threshold
is_match = total_score >= template.threshold
```

### Detection Storage Schema
```json
Upload.detectionResults = {
  "analysisId": "uuid-v4",
  "extractedText": "PT SIMON\nINVOICE INV-2024-001234...",
  "topCandidates": [
    {
      "templateId": "pt-simon-invoice-v1", 
      "clientName": "PT Simon",
      "docTypeName": "Invoice",
      "score": 42,
      "threshold": 35,
      "confidence": 0.85,
      "matched": true,
      "matchedRules": ["PT SIMON", "INVOICE", "INV-\\d{4}-\\d{6}"]
    },
    {
      "templateId": "pt-simon-receipt-v1",
      "clientName": "PT Simon", 
      "docTypeName": "Receipt",
      "score": 28,
      "threshold": 30,
      "confidence": 0.60,
      "matched": false,
      "matchedRules": ["PT SIMON"]
    }
  ],
  "selectedTemplate": "pt-simon-invoice-v1",
  "processingAllowed": true,
  "detectedAt": "2024-01-15T10:30:00Z"
}
```

## Implementation Phases Detail

### Phase 1 - Database & Upload (5 days)
**Day 1-2**: Database schema, migrations, seed data
**Day 3-4**: Upload API with detection integration  
**Day 5**: Frontend dropzone updates, type validation

### Phase 2 - Detection & Preview (5 days)
**Day 1-2**: Template matching engine, scoring algorithms
**Day 3-4**: Detection results UI, file cards enhancement
**Day 5**: Template override functionality, error handling

### Phase 3 - Processing & Integration (5 days)  
**Day 1-2**: Process endpoint, Job creation logic
**Day 3-4**: UI process controls, status management
**Day 5**: Testing, queue page integration, cleanup

## Risk Mitigations

### Template Matching Accuracy
- **Conservative thresholds**: Start with high confidence requirements (0.8+)
- **Top-N logging**: Store all candidate scores for machine learning tuning
- **Manual override**: Always allow manual template selection
- **A/B testing**: Gradual rollout with fallback to manual selection

### Performance Considerations  
- **Async detection**: Progress indicators during template matching
- **Subprocess timeouts**: Handle pdf2json stage failures gracefully
- **Batch processing**: Efficient multi-file detection algorithms
- **Database indexing**: Optimize template queries and rule matching

### Business Logic Flexibility
- **Per-template thresholds**: Different confidence requirements per client
- **Processing control**: `allowProcessWhenUnmatched` for business rules
- **Template versioning**: Support template evolution without breaking changes
- **Audit trails**: Complete detection history for troubleshooting

### Backward Compatibility
- **Existing jobs**: Current queue page continues working unchanged
- **Worker compatibility**: Jobs maintain `mapping` field for existing pipeline
- **API contracts**: Existing endpoints maintain response formats
- **Migration path**: Gradual transition from hardcoded to DB-driven rules

## Success Criteria
✅ **DB-driven validation**: Dropzone blocks disallowed files using FileType configuration  
✅ **Multi-file detection**: Upload multiple PDFs, see per-file detection results  
✅ **Confidence scoring**: Clear confidence levels with top-N candidate display  
✅ **Manual override**: Template selection dropdown for unmatched files  
✅ **Inline error handling**: Clear messages within file cards, no modal dialogs  
✅ **Existing pipeline**: Process button creates Jobs using unchanged worker pipeline  
✅ **Queue integration**: Seamless link to existing queue page for progress monitoring  
✅ **Download compatibility**: Existing download functionality works unchanged  
✅ **Session management**: Upload ownership tied to existing session system  
✅ **Performance**: Sub-3-second detection for typical invoices  

## Acceptance Testing

### End-to-End Scenarios
1. **Happy path**: Upload PT Simon invoice → auto-detect → process → download
2. **Multi-file**: Upload 5 different client documents → mixed detection results → batch process
3. **Unmatched handling**: Upload unknown document → show unmatched → manual selection → process  
4. **Error recovery**: Upload corrupted PDF → show error inline → remove and retry
5. **Type validation**: Drag non-PDF file → block with clear message → only allow valid types

### Performance Benchmarks
- **Upload + detection**: < 3 seconds for 10MB invoice
- **Multi-file handling**: 5 files processed in < 10 seconds
- **Database queries**: Template matching < 500ms
- **UI responsiveness**: No blocking during detection, smooth progress indicators
- **Memory usage**: Handle 20+ files without browser performance degradation

---

# Repo Intake Checklist

## Database & Schema
* **Path:** `/workspace/services/web/prisma/schema.prisma`
  **Purpose:** Current database models (Job, JobStatus enum)
  **Key symbols:** Job model, JobStatus, relationships, indices
  **Planned changes:** Add FileType, Template, Upload models; extend Job with upload references
  **Risks/notes:** Must preserve existing Job structure for worker compatibility

## Current Upload API
* **Path:** `/workspace/services/web/app/api/upload/route.ts`
  **Purpose:** Handles single file upload, creates Job immediately, deduplication logic
  **Key symbols:** uploadHandler, Job creation, SHA-256 hashing, session handling
  **Planned changes:** Add detection logic, create Upload record, defer Job creation to process step
  **Risks/notes:** Must maintain deduplication logic, session management patterns

## Job Management API
* **Path:** `/workspace/services/web/app/api/jobs/route.ts`
  **Purpose:** Lists jobs for queue page, handles polling
  **Key symbols:** Job queries, status filtering, response formatting
  **Planned changes:** May need to reference Upload data for template info display
  **Risks/notes:** Keep existing API contract for queue page compatibility

## Queue Page & Types
* **Path:** `/workspace/services/web/app/queue/page.tsx`
  **Purpose:** Displays jobs, handles polling, download links
  **Key symbols:** Job interface, status handling, polling logic
  **Planned changes:** Minimal - may add template/detection info display
  **Risks/notes:** Existing polling must continue working

## Home Page Integration
* **Path:** `/workspace/services/web/app/page.tsx`
  **Purpose:** Main landing page with PDFDropzone component
  **Key symbols:** PDFDropzone integration, hero section
  **Planned changes:** None - component enhancement handled in dropzone itself
  **Risks/notes:** Keep existing layout and styling

## Existing Dropzone Component
* **Path:** `/workspace/services/web/components/dropzone/PDFDropzone.tsx`
  **Purpose:** Current drag & drop UI with hardcoded PDF validation
  **Key symbols:** file validation, drag handlers, upload triggering
  **Planned changes:** Replace hardcoded validation with DB-driven, add detection results display
  **Risks/notes:** Must preserve accessibility, keyboard navigation

## File Item Component
* **Path:** `/workspace/services/web/components/dropzone/FileItem.tsx`
  **Purpose:** Individual file display in upload list
  **Key symbols:** File display, progress, remove handlers, status colors
  **Planned changes:** Add detection results display, template override UI, process buttons
  **Risks/notes:** Keep existing file management patterns, maintain responsive design

## Upload Hook
* **Path:** `/workspace/services/web/hooks/useUpload.ts`
  **Purpose:** Upload state management, file validation, progress tracking
  **Key symbols:** UploadState, file validation, progress handling
  **Planned changes:** Add detection state, template override handling, process actions
  **Risks/notes:** Must maintain existing file lifecycle management

## TypeScript Types
* **Path:** `/workspace/services/web/types/files.ts`
  **Purpose:** File handling interfaces (UploadedFile, UploadState, etc.)
  **Key symbols:** UploadedFile interface, status types, progress tracking
  **Planned changes:** Add detection result types, template types, process status
  **Risks/notes:** Must maintain compatibility with existing components

## Session Management
* **Path:** `/workspace/services/web/lib/session.ts`
  **Purpose:** Session creation and validation middleware
  **Key symbols:** withSession wrapper, session ID generation
  **Planned changes:** None - will reuse for Upload ownership
  **Risks/notes:** Critical for security - don't modify

## PDF Processing Stages (Reference Only)
* **Path:** `/workspace/services/pdf2json/stages/s01_tokenizer.py`
  **Purpose:** Text extraction from PDF using pdfplumber
  **Key symbols:** tokenize function, text extraction logic, bbox normalization
  **Planned changes:** None - will call as subprocess for detection
  **Risks/notes:** Must handle subprocess errors gracefully, timeout handling

* **Path:** `/workspace/services/pdf2json/stages/s02_normalizer.py`
  **Purpose:** Text normalization for consistent matching
  **Key symbols:** normalize_token_text, Unicode handling, punctuation mapping
  **Planned changes:** None - will use output for template matching
  **Risks/notes:** Subprocess dependency, handle timeouts, character encoding issues