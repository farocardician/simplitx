● Revised Drag & Drop PDF Processing Flow Implementation Plan

  Overview

  Ship a reliable drag & drop flow: PDFs → DB-driven Detection on Upload → Process via existing pipeline → Download. Detection
  happens during upload, not job processing. Everything database-driven with PostgreSQL+Prisma, supporting multiple files with inline
   error handling.

  Phase 1: Drop & Upload (Week 1)

  Goal: Multi-file drag & drop with DB-driven validation and upload-time detection

  Database Schema Updates

  - Add FileType model: id, mimeType, extensions[], label, enabled, maxSizeMB
  - Add Template model: id, name, clientName, docTypeName, matchRules (JSONB), threshold, priority, enabled
  - Add Upload model: id, sessionId, files[], detectionResults[], createdAt
  - Jobs remain unchanged - they only handle processing pipeline

  Detection Architecture

  - Detection happens during upload, stored in Upload.detectionResults
  - Template matching uses JSONB matchRules with weights per rule
  - Store top-N candidates with scores for tuning
  - Per-template threshold determines match/unmatch
  - DB flag allowProcessWhenUnmatched controls processing of unmatched files

  API Endpoints

  - GET /api/file-types - Return allowed types for Dropzone configuration
  - POST /api/upload - Upload + detect in single call, store results in Upload model
  - Jobs created only when user clicks "Process"

  Deliverable: Users drag & drop multiple PDFs, see detection results immediately

  Phase 2: Detect & Preview (Week 2)

  Goal: Rich preview with detection results and template override options

  UI Enhancements

  - File cards show: Client name, Document type, File type, Confidence score
  - Top-N candidate display for debugging/tuning
  - Unmatched files: inline configurable message based on allowProcessWhenUnmatched flag
  - Template override dropdown for manual selection

  Detection Details

  - Use s01_tokenizer.py + s02_normalizer.py for text extraction
  - JSONB matchRules: {"keywords": {"PT SIMON": 10, "INVOICE": 5}, "patterns": {"regex1": 8}}
  - Score aggregation with rule weights
  - Store full candidate list in Upload.detectionResults

  Deliverable: Rich detection preview with override capabilities

  Phase 3: Process & Queue (Week 3)

  Goal: Process button creates Jobs using existing pipeline

  Processing Flow

  - "Process" button creates Job records referencing Upload detection results
  - Uses existing worker pipeline (no changes to pdf2json stages)
  - Batch "Process All" for multiple files
  - Redirect to existing /queue page for monitoring

  Queue Integration

  - Jobs reference Upload.detectionResults for template selection
  - Existing pipeline remains unchanged
  - Download functionality unchanged

  Deliverable: Complete flow with existing queue/download system

  Technical Architecture

  Upload-Centric Detection

  Upload Flow: File → Upload + Detection → Store Results → [Later] Process → Job Creation

  Template Matching

  {
    "matchRules": {
      "keywords": {"PT SIMON": 10, "INVOICE": 5},
      "patterns": {"\\d{4}-\\d{6}": 8},
      "structure": {"has_table": 3}
    },
    "threshold": 15,
    "priority": 1
  }

  Detection Storage

  {
    "topCandidates": [
      {"templateId": "uuid", "score": 18.5, "matched": true},
      {"templateId": "uuid2", "score": 12.1, "matched": false}
    ],
    "selectedTemplate": "uuid",
    "confidence": 0.85
  }

  Risk Mitigations

  - Upload performance: Async detection with progress indicators
  - Template tuning: Store all candidate scores for analysis
  - Processing flexibility: allowProcessWhenUnmatched flag for business rules
  - Pipeline compatibility: Jobs created with existing structure when processing

  ---
  Repo Intake Checklist

  Database & Schema

  - Path: /workspace/services/web/prisma/schema.prisma
  Purpose: Current database models (Job, JobStatus enum)
  Key symbols: Job model, JobStatus, relationships, indices
  Planned changes: Add FileType, Template, Upload models; extend Job with upload references
  Risks/notes: Must preserve existing Job structure for worker compatibility

  Current Upload API

  - Path: /workspace/services/web/app/api/upload/route.ts
  Purpose: Handles single file upload, creates Job immediately, deduplication logic
  Key symbols: uploadHandler, Job creation, SHA-256 hashing, session handling
  Planned changes: Add detection logic, create Upload record, defer Job creation to process step
  Risks/notes: Must maintain deduplication logic, session management patterns

  Job Management API

  - Path: /workspace/services/web/app/api/jobs/route.ts
  Purpose: Lists jobs for queue page, handles polling
  Key symbols: Job queries, status filtering, response formatting
  Planned changes: May need to reference Upload data for template info display
  Risks/notes: Keep existing API contract for queue page compatibility

  Queue Page & Types

  - Path: /workspace/services/web/app/queue/page.tsx
  Purpose: Displays jobs, handles polling, download links
  Key symbols: Job interface, status handling, polling logic
  Planned changes: Minimal - may add template/detection info display
  Risks/notes: Existing polling must continue working

  Existing Dropzone Component

  - Path: /workspace/services/web/components/dropzone/PDFDropzone.tsx
  Purpose: Current drag & drop UI with hardcoded PDF validation
  Key symbols: file validation, drag handlers, upload triggering
  Planned changes: Replace hardcoded validation with DB-driven, add detection results display
  Risks/notes: Must preserve accessibility, keyboard navigation

  File Item Component

  - Path: /workspace/services/web/components/dropzone/FileItem.tsx
  Purpose: Individual file display in upload list
  Key symbols: File display, progress, remove handlers
  Planned changes: Add detection results display, template override UI
  Risks/notes: Keep existing file management patterns

  Upload Hook

  - Path: /workspace/services/web/hooks/useUpload.ts
  Purpose: Upload state management, file validation, progress tracking
  Key symbols: UploadState, file validation, progress handling
  Planned changes: Add detection state, template override handling
  Risks/notes: Must maintain existing file lifecycle management

  Session Management

  - Path: /workspace/services/web/lib/session.ts
  Purpose: Session creation and validation middleware
  Key symbols: withSession wrapper, session ID generation
  Planned changes: None - will reuse for Upload ownership
  Risks/notes: Critical for security - don't modify

  PDF Processing Stages (Reference Only)

  - Path: /workspace/services/pdf2json/stages/s01_tokenizer.py
  Purpose: Text extraction from PDF using pdfplumber
  Key symbols: tokenize function, text extraction logic
  Planned changes: None - will call as subprocess for detection
  Risks/notes: Must handle subprocess errors gracefully
  - Path: /workspace/services/pdf2json/stages/s02_normalizer.py
  Purpose: Text normalization for consistent matching
  Key symbols: normalize_token_text, Unicode handling
  Planned changes: None - will use output for template matching
  Risks/notes: Subprocess dependency, handle timeouts

  File Types & Validation (New Files)

  - Path: /workspace/services/web/types/files.ts (if exists)
  Purpose: TypeScript interfaces for file handling
  Key symbols: UploadedFile, UploadState types
  Planned changes: Add detection result types, template types
  Risks/notes: Must maintain compatibility with existing components