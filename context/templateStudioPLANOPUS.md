# Template Studio MVP Implementation Plan

## Phase 1: Foundation & Upload Pipeline
**Goal:** Enable multi-PDF upload and tokenization

### Backend Setup
- Set up Flask/FastAPI server with CORS enabled
- Create `/tokenize-batch` endpoint accepting multiple PDFs
- Implement basic tokenizer that extracts text/bbox per page (can use pdfplumber or similar)
- Store tokens in memory cache by `file_id` (simple dict for MVP)
- Add `/tokenize-status` endpoint for polling tokenization progress

### Frontend Setup  
- Create React app with single-page structure
- Build upload screen with drag-drop zone (react-dropzone)
- Implement file upload with progress tracking
- Add status list showing: Pending → Tokenizing → Done per file
- Auto-redirect to Studio when all files complete

**In-scope:** Basic tokenization, multi-file handling, status tracking
**Out-of-scope:** Authentication, file validation beyond PDF check, error recovery

---

## Phase 2: Studio Layout & Navigation
**Goal:** Create the dual-panel Studio with PDF switching

### Studio Structure
- Split screen: 30% config panel (left), 70% viewer (right)
- Add top toolbar: Zoom ±, Page selector dropdown, Overlay toggle
- Implement Left/Right arrow buttons for sample navigation
- Set up state management for:
  - `samples[]` array with file metadata
  - `currentSampleIndex` 
  - `viewState` (page, zoom, overlay visibility)

### PDF Viewer Integration
- Integrate PDF.js for rendering
- Load current sample's PDF into viewer
- Handle page navigation within current PDF
- Preserve zoom/page when switching samples

**In-scope:** Basic navigation, PDF rendering, state persistence
**Out-of-scope:** Keyboard shortcuts, thumbnails, search

---

## Phase 3: Config Editor (Minimal)
**Goal:** Enable basic region configuration

### Config Panel Components
- Region list with Add/Remove buttons
- Per region, show:
  - `id` field (text input)
  - `on_pages` dropdown (all/first/last)
  - Detection mode selector (anchors/fixed_box)
  
### Mode-specific Fields
- **For anchors mode:**
  - Pattern field (single text input)
  - Ignore case checkbox
  - Capture preset dropdown (right_only/right_then_rows)
  - If right_then_rows: rows spinner, dx_max slider
  
- **For fixed_box mode:**
  - Four number inputs for bbox coordinates

### Config State
- Store as JSON matching segmenter schema
- Initialize with minimal valid config
- Validate on change (basic checks only)

**In-scope:** Essential fields for testing overlays
**Out-of-scope:** inside/parent relationships, fallbacks, keep policy, all capture modes

---

## Phase 4: Live Overlay System
**Goal:** Real-time visual feedback

### Dry-run Integration
- Create `/segment/dryrun` endpoint using s03_segmenter.py
- Accept config + file_id + page, return segments
- No file writes, pure in-memory processing

### Overlay Rendering
- Draw colored rectangles on PDF canvas for each segment
- Use different colors per region ID
- Show region labels near boxes
- Update on:
  - Config changes (debounced 250ms)
  - Page changes
  - Sample switches

### Performance
- Cancel in-flight requests on new changes
- Cache last successful result per sample
- Reuse tokenization from Phase 1

**In-scope:** Basic overlay visualization, live updates
**Out-of-scope:** Segment text display, confidence scores, error regions

---

## Phase 5: Polish & Testing
**Goal:** Ensure smooth user experience

### UX Improvements
- Add loading spinners during processing
- Show error messages for invalid configs
- Highlight active region in editor
- Clear visual feedback for overlay toggle

### Edge Cases
- Handle PDFs with different page counts
- Gracefully degrade if tokenization fails
- Prevent config edits during active dry-run

### Testing
- Test with 3-5 sample invoice PDFs
- Verify overlay accuracy on different pages
- Ensure smooth switching between samples
- Check performance with 10+ page documents

**In-scope:** Critical bug fixes, basic error handling
**Out-of-scope:** Comprehensive validation, unit tests, CI/CD

---

## Technical Stack (Recommended)

**Backend:**
- Python 3.8+ with FastAPI
- pdfplumber for tokenization
- s03_segmenter.py as core engine

**Frontend:**
- React 18 with TypeScript
- PDF.js for rendering
- Tailwind CSS for styling
- Zustand for state management

**Notes for Later Phases:**
- Config save/load functionality
- Export overlays as annotated PDFs
- Regex builder/tester widget
- Multiple vendor sessions
- Batch testing across all samples
- Extended capture modes (below_only, around, etc.)
- Parent-child region relationships
- Confidence scoring
- Template library/marketplace

---

## Success Metrics for MVP
✓ User can upload 3+ PDFs and see them tokenized  
✓ Config changes update overlay within 500ms  
✓ Left/Right navigation maintains config state  
✓ Works with both anchors and fixed_box modes  
✓ Overlays correctly show on different pages/samples