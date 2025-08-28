# Upload Detection & Process Plan

## A) Prompt for Accurate Coding Sessions

```
You are a senior full-stack architect. Follow these rules:
- Treat the provided files as the single source of truth
- Do not hallucinate or assume beyond what's written
- If something is unclear, ask a concise clarifying question before proceeding

I'm implementing drag & drop upload with DB-driven client/template detection that enqueues to our existing backend pipeline.

Required inputs I'll provide:
- Current database schema (Prisma schema.prisma)
- Existing upload API endpoint (/api/upload/route.ts)
- Current queue page and job types
- Sample pipeline outputs from specified processing steps
- Dropzone component requirements and file type constraints

Return exactly:
1. Minimal file diffs/edits (no full file rewrites)
2. TypeScript types for new interfaces
3. API endpoint contracts with sample JSON payloads
4. Testable steps or test cases
5. Clear acceptance criteria for each change

Pre-flight checklist before answering:
□ Validate all required input files are referenced
□ Confirm DB schema changes align with detection logic
□ Verify API endpoints match existing patterns
□ Ensure state transitions preserve existing job pipeline
□ Check file type validation uses DB-driven approach
```

## B) Files I Will Provide for Accurate Code

**Database & Schema:**
- `/workspace/services/web/prisma/schema.prisma`
  - Current Job model structure and relationships
  - Need to see existing fields to add template detection fields correctly

**Current Upload Flow:**
- `/workspace/services/web/app/api/upload/route.ts`
  - Existing file upload logic and job creation
  - Shows current deduplication and session management patterns
- `/workspace/services/web/app/queue/page.tsx` 
  - Current job display and status handling
  - Need to understand existing Job interface and status flow

**UI Components:**
- `/workspace/services/web/components/upload/` (if exists)
  - Current upload components to extend with detection
  - Shows existing styling and interaction patterns

**Sample API Payloads:**

Upload Response:
```json
{
  "success": true,
  "job": {
    "id": "uuid",
    "filename": "invoice.pdf",
    "detectedClient": "PT Simon",
    "detectedDocType": "Invoice", 
    "detectedFileType": "PDF with Text Layer",
    "confidence": 0.85,
    "status": "uploaded"
  }
}
```

File Type Validation:
```json
{
  "allowedTypes": [
    {"mime": "application/pdf", "extensions": [".pdf"], "label": "PDF"}
  ],
  "maxFileSize": 10485760
}
```

## C) Which Pipeline Results to Provide (by task)

**For template detection logic (client/document type matching):**
- Provide outputs from `s01_tokenizer.py` and `s02_normalizer.py`
- Include 2-3 samples that successfully match known templates
- Include 1 sample that fails to match any template
- Need: extracted text structure, normalized tokens, any metadata that helps identify client patterns

**For file type detection (PDF structure analysis):**
- Provide outputs from `s01_tokenizer.py` 
- Include samples showing: PDF with text layer, scanned PDF, corrupted/invalid PDF
- Need: document structure metadata, text extractability indicators, quality scores

**General rule:** For code that changes step N, provide outputs and schema from step N-1 (plus any invariants N relies on). Always include 2–3 real samples that pass and 1 that fails, so tests and guards are accurate.

**Specific requirements:**
- Show actual JSON structure from pipeline outputs
- Include confidence scoring methodology 
- Provide template matching criteria (keywords, patterns, document structure)
- Include error cases and fallback handling examples