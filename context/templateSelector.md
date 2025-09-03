# Template Selector Implementation Documentation

## Overview

This document explains the implementation of a **pre-upload dropdown template selector** that allows users to choose a PDF processing configuration before uploading files. The feature enforces template selection by keeping the file dropzone disabled until a user makes a choice.

## What Was Built

A template selection system that:
- Displays available PDF processing templates in a dropdown menu
- Disables file upload until template is selected
- Passes the selected template to the PDF processing pipeline
- Maintains proper separation between PDF processing templates and XML mapping configurations
- Provides real-time feedback to users about the selection requirement

## Architecture Overview

The implementation follows a **microservices architecture** where:

1. **PDF2JSON Service** - Provides available templates via API endpoint and processes PDFs using selected template
2. **Web Service** - Displays template selector UI and handles file uploads  
3. **Worker Service** - Orchestrates processing pipeline using template for PDF processing and hardcoded mapping for XML conversion
4. **Gateway Service** - Routes requests between services

### Key Architectural Decision

The system uses **two separate mapping concepts**:
- **Template Selection**: Used for PDF→JSON processing (user selects from dropdown)
- **XML Mapping**: Used for JSON→XML conversion (hardcoded to existing mapping file)

This separation allows template flexibility for PDF processing while maintaining stability for XML output format.

## Implementation Steps

### Step 1: Add Templates API to PDF2JSON Service

**File**: `services/pdf2json/main.py`

**What to Add**:
Create a new GET endpoint called `/templates` that:
- Imports the `json` module at the top of the file
- Scans the `/app/config` directory for JSON files using `Path.glob("*.json")`
- Reads each JSON file and extracts `name` and `version` fields
- Creates labels in format "name version" (example: "Invoice PT Simon 1.3")
- Returns array of template objects with `id`, `name`, `version`, and `label` fields
- Sorts templates alphabetically by name
- Handles file reading errors gracefully with fallback template entries
- Returns JSON response with templates array and count

**Why This Approach**:
- Keeps template discovery in the service that actually uses the config files
- Provides clean API interface for the web service
- Maintains microservices separation of concerns

### Step 2: Create Templates API in Web Service

**File**: `services/web/app/api/templates/route.ts` (new file)

**What to Create**:
A new API route that:
- Makes HTTP request to PDF2JSON service templates endpoint
- Uses environment variable `PDF2JSON_URL` with fallback to `http://pdf2json:8000`
- Calls the `/templates` endpoint on PDF2JSON service
- Forwards the response to the frontend
- Handles connection errors and service failures
- Returns proper error responses with fallback empty templates array

**Why This Approach**:
- Follows microservices pattern where web service acts as API gateway
- Allows for future caching or transformation of template data if needed
- Keeps frontend decoupled from backend service URLs

### Step 3: Create TemplateSelector Component

**File**: `services/web/components/TemplateSelector.tsx` (new file)

**What to Create**:
A React component that:
- Fetches templates from `/api/templates` endpoint using `fetch()`
- Displays loading state while fetching templates
- Shows error state if template loading fails
- Renders HTML select dropdown with template options
- Uses "Choose a document template..." as placeholder option
- Calls `onSelectionChange` callback when selection changes
- Accepts `selectedTemplate` and `onSelectionChange` as props
- Includes proper accessibility attributes and labels
- Has TypeScript interface for props

**File**: `services/web/components/TemplateSelector.module.css` (new file)

**What to Create**:
CSS styling that:
- Styles the select dropdown with consistent look and feel
- Adds custom dropdown arrow using background SVG
- Includes hover and focus states
- Provides disabled state styling
- Adds responsive design for mobile devices
- Uses consistent spacing and typography with existing components

### Step 4: Modify useUpload Hook for Template State

**File**: `services/web/hooks/useUpload.ts`

**What to Modify**:
Add template management functionality:
- Add `selectedTemplate` state variable using `useState`
- Add `handleTemplateChange` function that clears files when template changes after files are added
- Include template parameter in upload form data within the `realUpload` function
- Update the hook's return object to include `selectedTemplate` and `handleTemplateChange`
- Add dependency on `selectedTemplate` in the `realUpload` callback dependencies

**Critical Logic**:
The `handleTemplateChange` function must check if files exist before changing template and clear them if template changes, preventing mismatched template-file combinations.

### Step 5: Update PDFDropzone Component

**File**: `services/web/components/dropzone/PDFDropzone.tsx`

**What to Modify**:
Transform component to accept shared state:
- Add `uploadHook` prop to component interface that accepts the return type of `useUpload`
- Remove internal `useUpload()` call and use the passed `uploadHook` instead
- Add `disabled` prop support to component interface
- Update all drag and drop event handlers to check `disabled` state
- Modify UI text to show "Select a template first" when disabled
- Add proper disabled styling class names
- Disable file input element when component is disabled
- Prevent all file operations when disabled state is true

**File**: `services/web/components/dropzone/PDFDropzone.module.css`

**What to Add**:
Disabled state CSS:
- Add `.dropzoneDisabled` class with reduced opacity and not-allowed cursor
- Add hover override for disabled state to prevent interactive styling
- Ensure disabled state takes visual precedence over other states

### Step 6: Update Main Page Layout

**File**: `services/web/app/page.tsx`

**What to Modify**:
Integrate template selector with upload flow:
- Add 'use client' directive at top of file for React hooks usage
- Import `TemplateSelector` and `useUpload` 
- Create single `useUpload()` hook instance at page level
- Pass template selection props to `TemplateSelector` component
- Pass upload hook instance and disabled state to `PDFDropzone` component
- Position `TemplateSelector` above `PDFDropzone` in the layout

**Why Single Hook Instance**:
Both components must share the same state instance to ensure template selection affects upload behavior. Creating separate hook instances would break the connection.

### Step 7: Update Upload API

**File**: `services/web/app/api/upload/route.ts`

**What to Modify**:
Handle template parameter in upload requests:
- Extract `template` parameter from form data
- Add validation to ensure template parameter is provided
- Replace hardcoded mapping value with the template parameter in database operations
- Update both duplicate checking and job creation to use template parameter
- Add proper error response if template is missing

**Important**: The template parameter becomes the `mapping` field in the database, which is later used by the worker service.

### Step 8: Fix Worker Service Configuration

**File**: `services/worker/src/processor.js`

**What to Modify**:
Correct the mapping parameter handling in `callGateway` function:
- Change the mapping parameter sent to gateway from template name to hardcoded `pt_simon_invoice_v1.json`
- Add comment explaining that template is used for PDF processing but XML conversion uses fixed mapping
- Keep the `fetchArtifacts` function using template parameter since it only calls PDF2JSON service

**Why This Fix**:
The gateway performs PDF→JSON→XML pipeline. The PDF→JSON step should use the selected template, but JSON→XML step must use the existing XML mapping file. The worker was incorrectly sending the template name to both steps.

## Critical Implementation Details

### State Management Pattern

The implementation uses a **shared hook pattern** where:
- Page component creates one `useUpload` hook instance
- Hook instance is passed down to child components
- This ensures all components share the same state
- Template changes automatically clear files through shared state

### Template vs Mapping Separation

**Two Different Configuration Types**:
1. **PDF Processing Templates** - Located in `services/pdf2json/config/` - Used for PDF→JSON conversion
2. **XML Mapping Files** - Located in `services/json2xml/mappings/` - Used for JSON→XML conversion

The user selects PDF processing template, but XML conversion always uses the same mapping file.

### Error Handling Strategy

The implementation includes multiple error handling layers:
- Template loading failures show user-friendly error messages
- Missing template selection prevents file upload
- API failures gracefully degrade to empty template lists
- Upload failures show clear error messages to users

## Testing the Implementation

### Verification Steps

1. **Template Loading**: Visit main page and verify dropdown loads with proper template names
2. **Disabled State**: Confirm dropzone shows disabled state until template selected
3. **Template Selection**: Select template and verify dropzone becomes enabled
4. **File Upload**: Upload PDF file and verify processing uses selected template
5. **Template Change**: Add files, change template, verify files are cleared
6. **End-to-End**: Complete upload process and verify job completes successfully

### Expected Behavior

- Dropdown shows: "Invoice PT Simon 1.3" and "Invoice Dummy 1"
- Dropzone shows: "Select a template first" when disabled
- Processing logs show: `--config /app/config/[selected-template].json`
- Jobs complete with "complete" status in queue

## Common Issues and Solutions

### Issue: Dropdown Shows "Loading templates..."

**Cause**: PDF2JSON service templates endpoint not accessible
**Solution**: Verify PDF2JSON service is running and templates endpoint returns data

### Issue: Upload Returns "Bad Request"

**Cause**: Template parameter not being sent in upload request
**Solution**: Ensure PDFDropzone component uses shared useUpload hook instance

### Issue: Processing Fails with "Gateway processing error"

**Cause**: Incorrect mapping parameter sent to JSON2XML service
**Solution**: Verify worker sends hardcoded XML mapping, not template name

### Issue: Files Don't Clear When Template Changes

**Cause**: Components using separate useUpload hook instances
**Solution**: Ensure page component passes single hook instance to all child components

## Important Dos and Don'ts

### DO:
- Use microservices pattern for template discovery
- Share single useUpload hook instance between components
- Separate PDF template selection from XML mapping configuration
- Include proper TypeScript interfaces for all new components
- Add comprehensive error handling at each layer
- Test the complete end-to-end flow after implementation

### DON'T:
- Hardcode template lists in frontend code
- Create multiple useUpload hook instances
- Mix PDF processing templates with XML mapping files
- Skip template validation in upload API
- Forget to handle loading and error states in UI
- Allow file upload without template selection

## File Summary

**New Files Created**:
- `services/web/components/TemplateSelector.tsx`
- `services/web/components/TemplateSelector.module.css`
- `services/web/app/api/templates/route.ts`

**Existing Files Modified**:
- `services/pdf2json/main.py` (added templates endpoint)
- `services/web/hooks/useUpload.ts` (added template state)
- `services/web/components/dropzone/PDFDropzone.tsx` (added disabled support)
- `services/web/components/dropzone/PDFDropzone.module.css` (added disabled styles)
- `services/web/app/page.tsx` (integrated template selector)
- `services/web/app/api/upload/route.ts` (handle template parameter)
- `services/worker/src/processor.js` (fixed mapping parameter)

This implementation provides a robust, user-friendly template selection system that properly integrates with the existing PDF processing pipeline while maintaining clean separation of concerns between services.