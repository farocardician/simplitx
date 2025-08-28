# Phase 3: User Interface - Detailed Implementation Plan

## 1. Goal
Build a complete queue page with live status updates, enabling users to monitor their PDF processing jobs and download completed XML files.

## 2. Scope

### Now (Phase 3)
- **Queue Page UI**: Full-featured status display with real-time updates
- **Polling System**: Efficient polling with stop conditions and incremental updates
- **Download API**: Secure endpoint for XML file downloads
- **Job Details API**: Individual job status endpoint
- **Status Visualization**: Badges, progress indicators, timestamps
- **Error Display**: User-friendly error messages
- **Basic Actions**: Download button, file size display
- **Mobile Responsive**: Adaptive layout for all screen sizes

### Later (Deferred)
- Retry button for failed jobs (Phase 4)
- Review functionality (Phase 5)
- Filters and pagination (Phase 5)
- Download all as ZIP (Future)
- Real-time WebSocket updates (Future)
- Job cancellation (Future)

## 3. Touchpoints

### API Layer
```
- Enhanced GET /api/jobs with incremental updates
- New GET /api/jobs/[id]/route.ts for job details
- New GET /api/jobs/[id]/download/route.ts for XML downloads
```

### UI Components
```
- Queue page with job list
- Status badges component
- File info display
- Polling hook with backoff
```

### Database
```
- Read-only queries for job status
- Update downloadCount on download
- Track firstDownloadAt timestamp
```

## 4. Implementation Tasks

### 4.1 Enhanced Jobs API with Incremental Updates
```typescript
// app/api/jobs/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withSession } from '@/lib/session';

export const GET = withSession(async (
  req: NextRequest, 
  { sessionId }: { sessionId: string }
) => {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
  const since = searchParams.get('since'); // ISO timestamp for incremental
  
  const where: any = { ownerSessionId: sessionId };
  
  if (status) {
    where.status = status;
  }
  
  if (since) {
    where.updatedAt = { gte: new Date(since) };
  }
  
  const jobs = await prisma.job.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      originalFilename: true,
      bytes: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      startedAt: true,
      completedAt: true,
      errorCode: true,
      errorMessage: true,
      mapping: true
    }
  });
  
  // Count active jobs for stop condition
  const activeCount = await prisma.job.count({
    where: {
      ownerSessionId: sessionId,
      status: { in: ['uploaded', 'queued', 'processing'] }
    }
  });
  
  return NextResponse.json({
    jobs: jobs.map(job => ({
      id: job.id,
      filename: job.originalFilename,
      bytes: Number(job.bytes),
      sizeFormatted: formatBytes(Number(job.bytes)),
      status: job.status,
      mapping: job.mapping,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      startedAt: job.startedAt?.toISOString() || null,
      completedAt: job.completedAt?.toISOString() || null,
      error: job.errorMessage ? {
        code: job.errorCode,
        message: job.errorMessage
      } : null,
      canDownload: job.status === 'complete'
    })),
    activeCount,
    timestamp: new Date().toISOString() // For next incremental fetch
  });
});
```

### 4.2 Download Endpoint
```typescript
// app/api/jobs/[id]/download/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withSession } from '@/lib/session';
import { createReadStream, statSync } from 'fs';
import { join } from 'path';

export const GET = withSession(async (
  req: NextRequest, 
  { params, sessionId }: { params: { id: string }, sessionId: string }
) => {
  // Verify ownership
  const job = await prisma.job.findFirst({
    where: {
      id: params.id,
      ownerSessionId: sessionId
    }
  });
  
  if (!job) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: "This file isn't yours" } },
      { status: 403 }
    );
  }
  
  if (job.status !== 'complete') {
    return NextResponse.json(
      { error: { code: 'NOT_READY', message: 'Conversion not finished yet' } },
      { status: 409 }
    );
  }
  
  if (!job.resultPath) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'Result file not found' } },
      { status: 404 }
    );
  }
  
  // Check if file exists
  const filePath = join(process.cwd(), job.resultPath);
  try {
    const stats = statSync(filePath);
    
    // Update download count
    await prisma.job.update({
      where: { id: job.id },
      data: {
        downloadCount: { increment: 1 },
        firstDownloadAt: job.firstDownloadAt || new Date()
      }
    });
    
    // Stream file
    const stream = createReadStream(filePath);
    const response = new NextResponse(stream as any);
    
    response.headers.set('Content-Type', 'application/xml');
    response.headers.set('Content-Length', stats.size.toString());
    response.headers.set(
      'Content-Disposition', 
      `attachment; filename="${job.id}.xml"`
    );
    
    return response;
    
  } catch (error) {
    if (error.code === 'ENOENT') {
      return NextResponse.json(
        { error: { code: 'EXPIRED', message: 'File was removed by retention' } },
        { status: 404 }
      );
    }
    throw error;
  }
});
```

### 4.3 Queue Page Component
```typescript
// app/queue/page.tsx
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { JobList } from '@/components/queue/JobList';
import { EmptyState } from '@/components/queue/EmptyState';
import { QueueHeader } from '@/components/queue/QueueHeader';
import { usePolling } from '@/hooks/usePolling';

export default function QueuePage() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const router = useRouter();
  
  // Polling with stop condition
  const { startPolling, stopPolling } = usePolling({
    onPoll: async (lastTimestamp) => {
      try {
        const params = new URLSearchParams();
        if (lastTimestamp) {
          params.set('since', lastTimestamp);
        }
        
        const res = await fetch(`/api/jobs?${params}`);
        if (!res.ok) throw new Error('Failed to fetch jobs');
        
        const data = await res.json();
        
        // Merge updates with existing jobs
        if (lastTimestamp) {
          setJobs(prev => {
            const updated = new Map(prev.map(j => [j.id, j]));
            data.jobs.forEach(job => updated.set(job.id, job));
            return Array.from(updated.values())
              .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          });
        } else {
          setJobs(data.jobs);
        }
        
        // Stop polling if no active jobs
        if (data.activeCount === 0) {
          stopPolling();
        }
        
        return data.timestamp;
        
      } catch (err) {
        setError(err.message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    interval: 3000, // 3 seconds
    backoffMax: 10000 // Max 10 seconds
  });
  
  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, []);
  
  const handleUploadMore = () => {
    router.push('/');
  };
  
  const handleDownload = async (jobId: string) => {
    window.location.href = `/api/jobs/${jobId}/download`;
  };
  
  if (loading && jobs.length === 0) {
    return <div className="flex justify-center p-8">Loading...</div>;
  }
  
  if (error) {
    return <div className="text-red-500 p-8">Error: {error}</div>;
  }
  
  return (
    <div className="container mx-auto p-4 md:p-8">
      <QueueHeader 
        totalJobs={jobs.length}
        activeJobs={jobs.filter(j => 
          ['uploaded', 'queued', 'processing'].includes(j.status)
        ).length}
        onUploadMore={handleUploadMore}
      />
      
      {jobs.length === 0 ? (
        <EmptyState onUploadFiles={handleUploadMore} />
      ) : (
        <JobList 
          jobs={jobs}
          onDownload={handleDownload}
        />
      )}
    </div>
  );
}
```

### 4.4 Job List Component
```typescript
// components/queue/JobList.tsx
import { StatusBadge } from './StatusBadge';
import { formatDistanceToNow } from 'date-fns';

interface Job {
  id: string;
  filename: string;
  sizeFormatted: string;
  status: string;
  mapping: string;
  createdAt: string;
  completedAt: string | null;
  error: { code: string; message: string } | null;
  canDownload: boolean;
}

export function JobList({ 
  jobs, 
  onDownload 
}: { 
  jobs: Job[]; 
  onDownload: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      {jobs.map(job => (
        <div 
          key={job.id}
          className="bg-white rounded-lg shadow p-4 md:p-6"
        >
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            {/* File Info */}
            <div className="flex-1">
              <h3 className="font-medium text-gray-900 truncate">
                {job.filename}
              </h3>
              <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
                <span>{job.sizeFormatted}</span>
                <span>•</span>
                <span>{job.mapping}</span>
                <span>•</span>
                <span>
                  {formatDistanceToNow(new Date(job.createdAt), { 
                    addSuffix: true 
                  })}
                </span>
              </div>
            </div>
            
            {/* Status */}
            <div className="flex items-center gap-4">
              <StatusBadge status={job.status} />
              
              {/* Actions */}
              <div className="flex gap-2">
                <button
                  disabled={true}
                  className="px-3 py-1 text-sm border rounded opacity-50 cursor-not-allowed"
                >
                  Review
                </button>
                
                <button
                  onClick={() => onDownload(job.id)}
                  disabled={!job.canDownload}
                  className={`
                    px-3 py-1 text-sm rounded
                    ${job.canDownload 
                      ? 'bg-blue-500 text-white hover:bg-blue-600' 
                      : 'bg-gray-200 text-gray-400 cursor-not-allowed'}
                  `}
                >
                  Download
                </button>
              </div>
            </div>
          </div>
          
          {/* Error Message */}
          {job.error && (
            <div className="mt-3 p-2 bg-red-50 text-red-700 rounded text-sm">
              {job.error.message}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

### 4.5 Status Badge Component
```typescript
// components/queue/StatusBadge.tsx
export function StatusBadge({ status }: { status: string }) {
  const config = {
    uploaded: { 
      label: 'Queued', 
      className: 'bg-gray-100 text-gray-700' 
    },
    queued: { 
      label: 'Waiting', 
      className: 'bg-yellow-100 text-yellow-700' 
    },
    processing: { 
      label: 'Processing...', 
      className: 'bg-blue-100 text-blue-700 animate-pulse' 
    },
    complete: { 
      label: 'Ready', 
      className: 'bg-green-100 text-green-700' 
    },
    failed: { 
      label: 'Failed', 
      className: 'bg-red-100 text-red-700' 
    }
  };
  
  const { label, className } = config[status] || config.uploaded;
  
  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}
```

### 4.6 Polling Hook
```typescript
// hooks/usePolling.ts
import { useRef, useCallback, useEffect } from 'react';

interface UsePollingOptions {
  onPoll: (lastTimestamp?: string) => Promise<string>;
  interval?: number;
  backoffMax?: number;
}

export function usePolling({ 
  onPoll, 
  interval = 3000,
  backoffMax = 10000 
}: UsePollingOptions) {
  const timeoutRef = useRef<NodeJS.Timeout>();
  const lastTimestampRef = useRef<string>();
  const backoffRef = useRef(interval);
  const isPollingRef = useRef(false);
  
  const poll = useCallback(async () => {
    if (!isPollingRef.current) return;
    
    try {
      const newTimestamp = await onPoll(lastTimestampRef.current);
      lastTimestampRef.current = newTimestamp;
      
      // Reset backoff on success
      backoffRef.current = interval;
      
    } catch (error) {
      // Exponential backoff on error
      backoffRef.current = Math.min(backoffRef.current * 2, backoffMax);
    }
    
    // Schedule next poll
    if (isPollingRef.current) {
      timeoutRef.current = setTimeout(poll, backoffRef.current);
    }
  }, [onPoll, interval, backoffMax]);
  
  const startPolling = useCallback(() => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;
    poll();
  }, [poll]);
  
  const stopPolling = useCallback(() => {
    isPollingRef.current = false;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
  }, []);
  
  // Pause when tab is hidden
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else if (isPollingRef.current) {
        poll();
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [poll, stopPolling]);
  
  return { startPolling, stopPolling };
}
```

## 5. Test Plan

### 5.1 Unit Tests
```typescript
// __tests__/components/StatusBadge.test.tsx
describe('StatusBadge', () => {
  test('Shows correct label for each status', () => {
    // Test uploaded → Queued
    // Test processing → Processing...
    // Test complete → Ready
  });
});

// __tests__/hooks/usePolling.test.ts
describe('usePolling', () => {
  test('Stops polling when activeCount is 0', () => {
    // Mock API response with activeCount: 0
    // Verify polling stops
  });
  
  test('Implements exponential backoff on errors', () => {
    // Force errors
    // Verify interval increases
  });
  
  test('Pauses when tab is hidden', () => {
    // Simulate visibilitychange
    // Verify polling pauses
  });
});
```

### 5.2 Integration Tests
```typescript
// __tests__/integration/queue-flow.test.ts
describe('Queue Page Flow', () => {
  test('Shows job status updates', async () => {
    // Create job in queued status
    // Load queue page
    // Update job to processing
    // Verify UI updates within polling interval
  });
  
  test('Download button enables when complete', async () => {
    // Create complete job
    // Verify download button enabled
    // Click download
    // Verify file downloaded
  });
  
  test('Shows error messages for failed jobs', async () => {
    // Create failed job with error
    // Verify error message displayed
  });
});
```

### 5.3 Manual Test Checklist
- [ ] Upload PDF → redirected to queue page
- [ ] Job appears in queue with "Queued" badge
- [ ] Status changes to "Processing..." with animation
- [ ] Status changes to "Ready" when complete
- [ ] Download button enables only when ready
- [ ] Click download → XML file downloads
- [ ] Error message shows for failed jobs
- [ ] Upload multiple files → all appear in list
- [ ] Polling stops when all jobs complete
- [ ] Switch tabs → polling pauses/resumes
- [ ] Mobile view → responsive layout works
- [ ] Empty state → shows when no jobs
- [ ] "Upload more" button → returns to upload page

## 6. Exit Criteria

### Functional Requirements Met
- [x] Queue page displays all user's jobs
- [x] Live status updates via polling
- [x] Download endpoint with ownership verification
- [x] Status badges with appropriate styling
- [x] Error messages displayed clearly
- [x] Incremental polling for efficiency
- [x] Polling stops when no active jobs
- [x] Tab visibility handling
- [x] Mobile responsive design

### Quality Metrics
- [ ] All unit tests passing
- [ ] Integration tests verify full flow
- [ ] Manual testing checklist complete
- [ ] Page load time < 500ms
- [ ] Polling efficiency verified (incremental updates)
- [ ] No memory leaks from polling

### Performance Baseline
- [ ] Queue page renders 100 jobs < 200ms
- [ ] API response time < 100ms for job list
- [ ] Download starts < 200ms after click
- [ ] Polling overhead < 5% CPU

### Documentation
- [ ] API endpoints documented
- [ ] Component hierarchy documented
- [ ] Polling strategy explained
- [ ] User guide for queue page

## Success Indicators
- Users can monitor job progress in real-time
- Download functionality works reliably
- UI provides clear feedback for all states
- System ready for Phase 4 (reliability improvements)
- Clean separation between UI and backend processing