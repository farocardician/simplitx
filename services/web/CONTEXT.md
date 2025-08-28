# Project Context: PDF Processing Web Interface

## Overview

This is a **Next.js 14 TypeScript web application** that provides a modern drag-and-drop interface for PDF file uploads and processing. The application serves as the frontend gateway for a larger PDF processing microservices system.

## Architecture & Technical Stack

### Framework Configuration
- **Next.js 14**: App Router architecture (not Pages Router)
- **TypeScript 5.0+**: Strict mode enabled with modern compiler options
- **Build Target**: Modern ES2020+ with bundler module resolution
- **Path Aliases**: `@/*` maps to project root for clean imports

### Project Structure & Organization

```
services/web/
├── app/                    # Next.js App Router (main application)
│   ├── api/               # Server-side API routes
│   │   ├── upload/route.ts    # POST /api/upload - PDF upload handler
│   │   └── healthz/route.ts   # GET /api/healthz - Health check
│   ├── layout.tsx         # Root layout with metadata and HTML structure
│   ├── page.tsx          # Homepage with hero section and upload interface
│   └── globals.css        # Global styles, CSS reset, accessibility
├── components/            # Reusable React components
│   └── dropzone/         # File upload component system
│       ├── PDFDropzone.tsx        # Main drag-drop interface component
│       ├── FileItem.tsx           # Individual file status display
│       └── PDFDropzone.module.css # Component-specific styles
├── hooks/                # Custom React hooks for business logic
│   └── useUpload.ts      # Upload state management and API integration
├── lib/                  # Pure utility functions
│   ├── bytes.ts          # File size formatting and validation
│   └── mime.ts           # PDF MIME type validation utilities
├── types/                # TypeScript type definitions
│   └── files.ts          # Upload-related interfaces and types
├── uploads/              # Local file storage directory
├── package.json          # Dependencies: React 18, Next.js 14, TypeScript 5
├── tsconfig.json         # TypeScript configuration with strict rules
└── next.config.js        # Next.js configuration (minimal setup)
```

## Core System Architecture

### Component Hierarchy & Data Flow
```
page.tsx
└── PDFDropzone (main interface)
    ├── useUpload hook (state management)
    └── FileItem[] (for each uploaded file)
        └── Individual file state & actions
```

### State Management Pattern
- **Custom Hook Architecture**: `useUpload` centralizes all upload logic
- **Local State Only**: No external state management (Redux, Zustand, etc.)
- **Immutable Updates**: Uses React's state updater patterns
- **Real-time Updates**: Progress tracking via XMLHttpRequest events

### Upload System Architecture

#### File Upload Lifecycle
1. **File Selection**: Drag-drop or file picker
2. **Client Validation**: PDF format, size, duplicates
3. **Queue Management**: Add to upload queue with unique IDs
4. **Concurrent Processing**: Up to 3 simultaneous uploads
5. **Progress Tracking**: Real-time progress updates
6. **Completion/Error Handling**: Final status updates

#### Key Components Deep Dive

#### 1. PDFDropzone Component (`components/dropzone/PDFDropzone.tsx`)
**Purpose**: Main user interface for file uploads
**Architecture**: 
- **State**: Drag state, error state management
- **Event Handling**: Comprehensive drag-and-drop lifecycle
- **Validation**: Real-time feedback during drag operations
- **Integration**: Uses `useUpload` hook for business logic
- **Accessibility**: ARIA labels, keyboard navigation, focus management
- **Styling**: CSS Modules with dynamic class application

**Key Features**:
- Visual drag states with error feedback
- File type validation during drag
- Click-to-select fallback
- Keyboard accessibility
- Mobile-responsive design

#### 2. FileItem Component (`components/dropzone/FileItem.tsx`)
**Purpose**: Display individual file upload status
**Architecture**:
- **Props Interface**: Typed file data and callback functions
- **State Display**: Dynamic status rendering with color coding
- **Progress Visualization**: Animated progress bar
- **Action Buttons**: Context-sensitive Cancel/Remove buttons
- **Styling**: styled-jsx for component-scoped CSS

#### 3. useUpload Hook (`hooks/useUpload.ts`)
**Purpose**: Centralized upload state management and API integration
**Architecture**:
- **State Management**: Complex state with files array and metadata
- **File Validation**: Multi-layer validation (format, size, duplicates)
- **Upload Queue**: Manages pending, in-progress, and completed files
- **Concurrency Control**: Limits simultaneous uploads (3 max)
- **Error Handling**: Comprehensive error states and user messages
- **Cancellation**: AbortController integration for upload cancellation

**Key Patterns**:
- Immutable state updates with spread operators
- Callback memoization for performance
- XMLHttpRequest for progress tracking (not fetch API)
- Promise-based upload management

### API Layer Architecture

#### Upload Endpoint (`app/api/upload/route.ts`)
**Method**: POST `/api/upload`
**Architecture**:
- **Input**: FormData with single file
- **Validation**: Server-side PDF validation and size checking
- **Storage**: Local filesystem with timestamp-based naming
- **Response**: Detailed success/error JSON responses
- **Error Handling**: Try-catch with structured error responses

**Security Measures**:
- MIME type validation
- File size limits (50MB)
- Unique filename generation
- Directory traversal prevention

#### Health Check (`app/api/healthz/route.ts`)
**Method**: GET `/api/healthz`
**Purpose**: Simple service health monitoring
**Response**: `{ ok: true }`

### Type System Architecture

#### Core Types (`types/files.ts`)
```typescript
UploadedFile {
  id: string              // Unique identifier
  file: File              // Original File object
  name: string            // Display name
  size: number            // File size in bytes
  sizeFormatted: string   // Human-readable size
  progress: number        // Upload percentage (0-100)
  status: UploadStatus    // Current state
  error?: string          // Error message if failed
  abortController?: AbortController // Cancellation control
}

UploadState {
  files: UploadedFile[]   // All tracked files
  isUploading: boolean    // Global upload state
  error: string | null    // Global error message
}
```

### Styling Architecture

#### CSS Organization
- **Global Styles**: Modern CSS reset, accessibility defaults
- **Component Styles**: CSS Modules for scoped styles
- **Inline Styles**: styled-jsx for dynamic component styling
- **Design System**: Consistent color palette, spacing, typography

#### Responsive Design
- Mobile-first approach
- Flexible layouts for various screen sizes
- Touch-friendly interactive elements
- Accessible focus indicators

### Utility Libraries

#### File Size Management (`lib/bytes.ts`)
- **formatBytes()**: Converts bytes to human-readable format (KB, MB, GB)
- **parseBytes()**: Parses size strings back to numeric bytes
- **exceedsLimit()**: Validates file size against limits
- **Pattern**: Pure functions with comprehensive edge case handling

#### PDF Validation (`lib/mime.ts`)
- **Multi-layer Validation**: MIME type + file extension
- **Security-focused**: Both checks must pass
- **Comprehensive MIME Support**: Multiple PDF MIME type variants
- **User-friendly Errors**: Descriptive validation error messages

## Integration Context

### Microservices Architecture
This web interface is the frontend component of a larger PDF processing system:
- **Gateway Service**: Request routing and load balancing
- **PDF2JSON Service**: Document parsing and data extraction  
- **JSON2XML Service**: Format transformation
- **Worker Services**: Background processing
- **Docker Infrastructure**: Containerized deployment

### Current Implementation Status
- **Frontend**: Fully implemented with modern React patterns
- **File Upload**: Complete with validation and progress tracking
- **Local Storage**: Files saved to local `uploads/` directory
- **TODO**: Integration with downstream processing services
- **TODO**: Real-time processing status updates
- **TODO**: Result delivery and download functionality

## Development Considerations

### Code Quality Standards
- **TypeScript Strict Mode**: Full type safety enforcement
- **Modern React Patterns**: Hooks, functional components
- **Accessibility**: WCAG compliance with ARIA labels
- **Performance**: Memoized callbacks, optimized re-renders
- **Error Boundaries**: Comprehensive error handling

### Security Implementation
- **Input Validation**: Client and server-side validation
- **File Type Restrictions**: PDF-only with multiple validation layers
- **Size Limits**: 50MB maximum file size
- **Path Security**: Prevents directory traversal attacks
- **Upload Destination**: Sandboxed uploads directory

### Scalability Considerations
- **Concurrent Upload Limits**: Prevents resource exhaustion
- **Memory Management**: File streaming for large uploads
- **Error Recovery**: Graceful handling of network failures
- **State Management**: Optimized for large file lists

This architecture provides a solid foundation for a production PDF processing interface with room for integration with backend processing services.