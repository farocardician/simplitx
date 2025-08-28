# Enhanced Upload Flow - Implementation Plan

## Overview

Transform the current single-file auto-processing upload into a scalable, multi-file drag & drop system with intelligent template matching and manual processing control.

## Goals

1. **Scalable Template System**: Database-driven client/document detection
2. **Multi-File Support**: Drag & drop multiple files with individual status tracking
3. **Manual Processing Control**: Preview → Process button → Queue (existing flow)
4. **Future-Proof**: Easy to add new clients, file types, and templates via database

## Architecture Overview

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Enhanced      │    │   File Analysis  │    │   Existing      │
│   Upload UI     │ -> │   & Template     │ -> │   Queue System  │
│                 │    │   Matching API   │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
        │                        │                        │
        │                        │                        │
    dropzone.js             PostgreSQL              Current Worker
    Multi-file UI           Template DB              Processing
```

## Phase 1: Database Schema & Template System

### 1.1 Database Schema

```sql
-- Extend existing Prisma schema

-- Allowed file types (configurable)
model FileType {
  id          String   @id @default(uuid())
  name        String   @unique // "PDF", "DOC", etc.
  mimeTypes   String[] // ["application/pdf"]
  extensions  String[] // [".pdf"]
  enabled     Boolean  @default(true)
  maxSizeMB   Int      @default(50)
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  
  // Relations
  templates   Template[]
  
  @@map("file_types")
}

-- Template definitions for client/document detection
model Template {
  id              String      @id @default(uuid())
  name            String      // "PT Simon Invoice Template"
  clientName      String      @map("client_name") // "PT Simon"
  documentType    String      @map("document_type") // "Invoice"
  fileTypeId      String      @map("file_type_id")
  
  // Matching rules (JSON)
  matchRules      Json        @map("match_rules") // Flexible rule definitions
  threshold       Float       @default(0.7) // Minimum confidence score
  priority        Int         @default(100) // Higher = evaluated first
  
  enabled         Boolean     @default(true)
  createdAt       DateTime    @default(now()) @map("created_at")
  updatedAt       DateTime    @updatedAt @map("updated_at")
  
  // Relations
  fileType        FileType    @relation(fields: [fileTypeId], references: [id])
  
  @@map("templates")
}

-- File analysis results (extend existing Job)
model Job {
  // ... existing fields ...
  
  // New fields for template matching
  detectedClient     String?   @map("detected_client")
  detectedDocType    String?   @map("detected_doc_type")
  detectedFileType   String?   @map("detected_file_type")
  templateId         String?   @map("template_id")
  matchConfidence    Float?    @map("match_confidence")
  analysisStatus     AnalysisStatus @default(pending) @map("analysis_status")
  analysisError      String?   @map("analysis_error")
  
  // Relations
  template           Template? @relation(fields: [templateId], references: [id])
  
  @@map("jobs")
}

enum AnalysisStatus {
  pending
  analyzing
  matched
  unmatched
  error
  @@map("analysis_status")
}
```

### 1.2 Template Matching Rules Format

```typescript
// Example match rules structure
interface MatchRules {
  textPatterns: {
    clientIndicators: string[];     // ["PT SIMON", "PT. Simon Tbk"]
    documentIndicators: string[];   // ["INVOICE", "FAKTUR"]
    requiredFields: string[];       // ["Invoice No", "Date"]
  };
  structuralRules: {
    hasTable: boolean;             // Must have table structure
    minLines: number;              // Minimum line items
    maxPages: number;              // Maximum pages
  };
  weights: {
    clientMatch: number;           // 0.4
    documentMatch: number;         // 0.3
    structuralMatch: number;       // 0.3
  };
}
```

## Phase 2: Enhanced Upload Component

### 2.1 Dependencies & Setup

```bash
# Add to package.json
npm install react-dropzone
```

### 2.2 New File Upload State Management

```typescript
// types/upload.ts - Enhanced types
interface UploadedFile {
  id: string;
  file: File;
  name: string;
  size: number;
  sizeFormatted: string;
  
  // Upload status
  uploadStatus: 'pending' | 'uploading' | 'uploaded' | 'failed';
  uploadProgress: number;
  uploadError?: string;
  
  // Analysis status
  analysisStatus: 'pending' | 'analyzing' | 'matched' | 'unmatched' | 'error';
  analysisError?: string;
  
  // Detection results
  detectedClient?: string;
  detectedDocType?: string;
  detectedFileType?: string;
  matchConfidence?: number;
  templateId?: string;
  
  // Processing status
  jobId?: string;
  canProcess: boolean;
}

interface UploadState {
  files: UploadedFile[];
  allowedTypes: FileType[];
  isAnalyzing: boolean;
  error: string | null;
}
```

### 2.3 Enhanced Upload Hook

```typescript
// hooks/useEnhancedUpload.ts
export function useEnhancedUpload() {
  const [uploadState, setUploadState] = useState<UploadState>({
    files: [],
    allowedTypes: [],
    isAnalyzing: false,
    error: null
  });

  // Fetch allowed file types on mount
  useEffect(() => {
    fetchAllowedTypes();
  }, []);

  const fetchAllowedTypes = async () => {
    const response = await fetch('/api/file-types');
    const types = await response.json();
    setUploadState(prev => ({ ...prev, allowedTypes: types }));
  };

  const validateFile = (file: File): string | null => {
    const allowedType = uploadState.allowedTypes.find(type =>
      type.mimeTypes.includes(file.type) ||
      type.extensions.some(ext => file.name.toLowerCase().endsWith(ext.toLowerCase()))
    );
    
    if (!allowedType) {
      return `File type not supported. Allowed: ${uploadState.allowedTypes.map(t => t.extensions.join(', ')).join(', ')}`;
    }
    
    if (file.size > allowedType.maxSizeMB * 1024 * 1024) {
      return `File too large. Maximum size: ${allowedType.maxSizeMB}MB`;
    }
    
    return null;
  };

  const addFiles = async (newFiles: File[]) => {
    // Validate files
    const validFiles: UploadedFile[] = [];
    const errors: string[] = [];
    
    for (const file of newFiles) {
      const error = validateFile(file);
      if (error) {
        errors.push(`${file.name}: ${error}`);
        continue;
      }
      
      const uploadedFile: UploadedFile = {
        id: generateId(),
        file,
        name: file.name,
        size: file.size,
        sizeFormatted: formatBytes(file.size),
        uploadStatus: 'pending',
        uploadProgress: 0,
        analysisStatus: 'pending',
        canProcess: false
      };
      
      validFiles.push(uploadedFile);
    }
    
    if (validFiles.length > 0) {
      setUploadState(prev => ({
        ...prev,
        files: [...prev.files, ...validFiles],
        error: errors.length > 0 ? errors.join('\n') : null
      }));
      
      // Start upload and analysis for each file
      validFiles.forEach(uploadAndAnalyze);
    }
  };

  const uploadAndAnalyze = async (fileData: UploadedFile) => {
    try {
      // Phase 1: Upload
      await uploadFile(fileData);
      
      // Phase 2: Analyze
      await analyzeFile(fileData);
      
    } catch (error) {
      updateFileStatus(fileData.id, {
        uploadStatus: 'failed',
        uploadError: error.message
      });
    }
  };

  // ... rest of implementation
}
```

### 2.4 Enhanced Dropzone Component

```typescript
// components/upload/EnhancedDropzone.tsx
import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { useEnhancedUpload } from '@/hooks/useEnhancedUpload';

export function EnhancedDropzone() {
  const { files, addFiles, removeFile, processFiles, allowedTypes } = useEnhancedUpload();
  
  const onDrop = useCallback((acceptedFiles: File[], rejectedFiles: any[]) => {
    if (rejectedFiles.length > 0) {
      // Handle rejected files
      console.log('Rejected files:', rejectedFiles);
    }
    
    if (acceptedFiles.length > 0) {
      addFiles(acceptedFiles);
    }
  }, [addFiles]);

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    accept: getAcceptTypes(allowedTypes), // Convert to react-dropzone format
    maxSize: getMaxSize(allowedTypes),
    multiple: true
  });

  return (
    <div className="space-y-6">
      {/* Dropzone */}
      <div
        {...getRootProps()}
        className={`
          border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors
          ${isDragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300'}
          ${isDragReject ? 'border-red-500 bg-red-50' : ''}
        `}
      >
        <input {...getInputProps()} />
        <DropzoneContent isDragActive={isDragActive} isDragReject={isDragReject} />
      </div>

      {/* File List */}
      {files.length > 0 && (
        <FileList 
          files={files} 
          onRemove={removeFile}
          onProcess={processFiles}
        />
      )}
    </div>
  );
}
```

## Phase 3: File Analysis API

### 3.1 File Types API

```typescript
// app/api/file-types/route.ts
export async function GET() {
  const fileTypes = await prisma.fileType.findMany({
    where: { enabled: true },
    orderBy: { name: 'asc' }
  });
  
  return NextResponse.json(fileTypes);
}
```

### 3.2 File Analysis API

```typescript
// app/api/files/[id]/analyze/route.ts
export const POST = withSession(async (
  req: NextRequest,
  { sessionId }: { sessionId: string },
  { params }: { params: { id: string } }
) => {
  const job = await prisma.job.findFirst({
    where: {
      id: params.id,
      ownerSessionId: sessionId
    }
  });
  
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  
  try {
    // Update status
    await prisma.job.update({
      where: { id: job.id },
      data: { analysisStatus: 'analyzing' }
    });
    
    // Extract text (light pass using s01_tokenizer logic)
    const textContent = await extractTextPreview(job.uploadPath);
    
    // Get candidate templates
    const templates = await prisma.template.findMany({
      where: { 
        enabled: true,
        fileType: { enabled: true }
      },
      include: { fileType: true },
      orderBy: { priority: 'desc' }
    });
    
    // Score templates
    const matchResults = await scoreTemplates(textContent, templates);
    const bestMatch = matchResults.find(result => result.score >= result.template.threshold);
    
    if (bestMatch) {
      // Template matched
      await prisma.job.update({
        where: { id: job.id },
        data: {
          analysisStatus: 'matched',
          detectedClient: bestMatch.template.clientName,
          detectedDocType: bestMatch.template.documentType,
          detectedFileType: bestMatch.template.fileType.name,
          templateId: bestMatch.template.id,
          matchConfidence: bestMatch.score
        }
      });
    } else {
      // No template matched
      await prisma.job.update({
        where: { id: job.id },
        data: {
          analysisStatus: 'unmatched',
          analysisError: 'No matching template found'
        }
      });
    }
    
    return NextResponse.json({ success: true });
    
  } catch (error) {
    await prisma.job.update({
      where: { id: job.id },
      data: {
        analysisStatus: 'error',
        analysisError: error.message
      }
    });
    
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
});
```

### 3.3 Template Matching Engine

```typescript
// lib/templateMatcher.ts
interface MatchResult {
  template: Template;
  score: number;
  details: {
    clientScore: number;
    documentScore: number;
    structuralScore: number;
  };
}

export async function scoreTemplates(
  textContent: string, 
  templates: Template[]
): Promise<MatchResult[]> {
  const results: MatchResult[] = [];
  
  for (const template of templates) {
    const rules = template.matchRules as MatchRules;
    
    // Calculate individual scores
    const clientScore = calculateClientScore(textContent, rules.textPatterns.clientIndicators);
    const documentScore = calculateDocumentScore(textContent, rules.textPatterns.documentIndicators);
    const structuralScore = await calculateStructuralScore(textContent, rules.structuralRules);
    
    // Weighted final score
    const finalScore = 
      (clientScore * rules.weights.clientMatch) +
      (documentScore * rules.weights.documentMatch) +
      (structuralScore * rules.weights.structuralMatch);
    
    results.push({
      template,
      score: finalScore,
      details: {
        clientScore,
        documentScore,
        structuralScore
      }
    });
  }
  
  return results.sort((a, b) => b.score - a.score);
}

function calculateClientScore(text: string, indicators: string[]): number {
  const normalizedText = text.toUpperCase();
  let maxScore = 0;
  
  for (const indicator of indicators) {
    if (normalizedText.includes(indicator.toUpperCase())) {
      maxScore = Math.max(maxScore, 1.0);
    }
  }
  
  return maxScore;
}

// ... similar functions for document and structural scoring
```

## Phase 4: Process Button & Queue Integration

### 4.1 Process Files Function

```typescript
// In useEnhancedUpload hook
const processFiles = async (fileIds?: string[]) => {
  const filesToProcess = fileIds 
    ? files.filter(f => fileIds.includes(f.id) && f.canProcess)
    : files.filter(f => f.canProcess);
  
  for (const file of filesToProcess) {
    if (file.jobId) {
      // Trigger existing processing pipeline
      await fetch(`/api/jobs/${file.jobId}/process`, {
        method: 'POST'
      });
    }
  }
  
  // Redirect to queue page
  router.push('/queue');
};
```

### 4.2 Process Job API

```typescript
// app/api/jobs/[id]/process/route.ts
export const POST = withSession(async (
  req: NextRequest,
  { sessionId }: { sessionId: string },
  { params }: { params: { id: string } }
) => {
  const job = await prisma.job.findFirst({
    where: {
      id: params.id,
      ownerSessionId: sessionId,
      status: 'queued' // Only allow processing of queued jobs
    }
  });
  
  if (!job) {
    return NextResponse.json({ error: 'Job not found or not processable' }, { status: 404 });
  }
  
  // Job is already queued - worker will pick it up automatically
  // No changes needed to existing processing pipeline
  
  return NextResponse.json({ success: true });
});
```

## Phase 5: File Status UI Components

### 5.1 File Item Component

```typescript
// components/upload/FileItem.tsx
interface FileItemProps {
  file: UploadedFile;
  onRemove: (id: string) => void;
}

export function FileItem({ file, onRemove }: FileItemProps) {
  return (
    <div className="border rounded-lg p-4 space-y-3">
      {/* File Info */}
      <div className="flex items-center justify-between">
        <div>
          <h4 className="font-medium">{file.name}</h4>
          <p className="text-sm text-gray-500">{file.sizeFormatted}</p>
        </div>
        <button onClick={() => onRemove(file.id)}>Remove</button>
      </div>
      
      {/* Upload Progress */}
      {file.uploadStatus === 'uploading' && (
        <ProgressBar progress={file.uploadProgress} />
      )}
      
      {/* Analysis Results */}
      {file.analysisStatus === 'matched' && (
        <div className="bg-green-50 p-3 rounded">
          <div className="flex items-center gap-2">
            <CheckIcon className="w-4 h-4 text-green-500" />
            <span className="text-green-700 font-medium">Template Matched</span>
          </div>
          <div className="text-sm text-green-600 mt-1">
            Client: {file.detectedClient} • Type: {file.detectedDocType}
          </div>
          <div className="text-xs text-green-500">
            Confidence: {(file.matchConfidence * 100).toFixed(1)}%
          </div>
        </div>
      )}
      
      {file.analysisStatus === 'unmatched' && (
        <div className="bg-yellow-50 p-3 rounded">
          <div className="flex items-center gap-2">
            <WarningIcon className="w-4 h-4 text-yellow-500" />
            <span className="text-yellow-700 font-medium">No Template Match</span>
          </div>
          <p className="text-sm text-yellow-600 mt-1">
            {file.analysisError}
          </p>
          <div className="mt-2 text-xs">
            <button className="text-blue-600 hover:underline">
              Upload different file
            </button>
            <span className="mx-2">or</span>
            <button className="text-blue-600 hover:underline">
              Process anyway
            </button>
          </div>
        </div>
      )}
      
      {file.analysisStatus === 'error' && (
        <div className="bg-red-50 p-3 rounded">
          <div className="flex items-center gap-2">
            <ErrorIcon className="w-4 h-4 text-red-500" />
            <span className="text-red-700 font-medium">Analysis Error</span>
          </div>
          <p className="text-sm text-red-600 mt-1">
            {file.analysisError}
          </p>
        </div>
      )}
    </div>
  );
}
```

### 5.2 Batch Actions

```typescript
// components/upload/FileList.tsx
export function FileList({ files, onRemove, onProcess }: FileListProps) {
  const processableFiles = files.filter(f => f.canProcess);
  const hasProcessableFiles = processableFiles.length > 0;
  
  return (
    <div className="space-y-4">
      {/* Batch Actions */}
      {hasProcessableFiles && (
        <div className="flex justify-between items-center p-4 bg-blue-50 rounded-lg">
          <span className="text-blue-700">
            {processableFiles.length} files ready to process
          </span>
          <button
            onClick={() => onProcess()}
            className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
          >
            Process All Files
          </button>
        </div>
      )}
      
      {/* Individual Files */}
      {files.map(file => (
        <FileItem key={file.id} file={file} onRemove={onRemove} />
      ))}
    </div>
  );
}
```

## Implementation Timeline

### Week 1: Database & Template System
- [ ] Add database schema migration
- [ ] Create file types and templates seed data
- [ ] Implement template matching engine
- [ ] Build file analysis API

### Week 2: Enhanced Upload UI
- [ ] Add react-dropzone dependency
- [ ] Build enhanced upload hook
- [ ] Create new dropzone component
- [ ] Implement file status components

### Week 3: Integration & Testing
- [ ] Wire up process button to existing queue
- [ ] Test multi-file upload flow
- [ ] Add error handling and edge cases
- [ ] Polish UI and transitions

### Week 4: Template Management (Future)
- [ ] Admin interface for template management
- [ ] Template testing and validation tools
- [ ] Analytics and matching performance monitoring

## Success Metrics

1. **User Experience**
   - Drag & drop works smoothly with visual feedback
   - Template matching provides clear, actionable results
   - Multi-file handling is intuitive

2. **System Performance**
   - File analysis completes within 3 seconds
   - Template matching accuracy > 90% for known formats
   - No impact on existing processing pipeline

3. **Scalability**
   - Easy to add new templates via database
   - Support for new file types without code changes
   - Clear path to admin interface for template management

## Technical Considerations

### Security
- Validate file types on both client and server
- Sanitize extracted text before template matching
- Rate limit file analysis API

### Performance
- Cache template rules in memory
- Use lightweight text extraction (avoid full PDF parsing)
- Implement file size limits per type

### Monitoring
- Log template matching results for improvement
- Track analysis performance metrics
- Monitor for new document patterns

## Migration Strategy

1. **Backward Compatibility**: Keep existing upload working during rollout
2. **Feature Flags**: Enable enhanced upload for subset of users first
3. **Fallback**: If analysis fails, fall back to existing auto-process flow
4. **Data Migration**: Seed initial file types and templates from current mappings

This implementation plan provides a robust, scalable foundation for the enhanced upload flow while maintaining compatibility with existing systems.