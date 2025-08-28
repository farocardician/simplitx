# Phase 4: Reliability Layer - Detailed Implementation Plan

## 1. Goal
Implement comprehensive failure handling, automatic retry mechanisms, circuit breaker pattern, and manual retry capabilities to ensure system resilience and graceful degradation under failure conditions.

## 2. Scope

### Now (Phase 4)
- **Automatic Retry Logic**: Exponential backoff with jitter for transient failures
- **Circuit Breaker**: Protect gateway from cascading failures
- **Manual Retry API**: Allow users to retry failed jobs
- **Enhanced Error Taxonomy**: Detailed error classification and user messages
- **Concurrent Processing Control**: Worker concurrency limits and backpressure
- **Timeout Handling**: Configurable timeouts with proper cleanup
- **Lease Extension**: Heartbeat mechanism for long-running jobs
- **Dead Letter Queue**: Mark permanently failed jobs

### Later (Deferred)
- Distributed tracing (Phase 5)
- Advanced metrics and alerting (Phase 5)
- Job cancellation (Future)
- Priority queues (Future)
- Rate limiting per user (Future)
- Webhook notifications (Future)

## 3. Touchpoints

### Worker Service
```
- Retry logic implementation
- Circuit breaker state management
- Concurrency pool management
- Lease extension mechanism
```

### Database
```
- attemptCount tracking
- lastAttemptAt timestamp
- retryAfter timestamp
- circuitBreakerState tracking
```

### API Layer
```
- POST /api/jobs/[id]/retry endpoint
- Enhanced error responses
- Retry status in job list
```

### UI
```
- Retry button for failed jobs
- Retry status indicators
- Circuit breaker warnings
```

## 4. Implementation Tasks

### 4.1 Enhanced Error Taxonomy
```typescript
// lib/errors.ts
export enum ErrorCode {
  // Client errors (no retry)
  NOT_PDF = 'NOT_PDF',
  TOO_LARGE = 'TOO_LARGE',
  INVALID_MAPPING = 'INVALID_MAPPING',
  
  // Gateway errors (retryable)
  GW_4XX = 'GW_4XX',        // No retry
  GW_5XX = 'GW_5XX',        // Retry
  GW_TIMEOUT = 'GW_TIMEOUT', // Retry
  GW_UNAVAILABLE = 'GW_UNAVAILABLE', // Retry
  
  // System errors (retryable)
  IO_ERROR = 'IO_ERROR',     // Retry once
  MEMORY_ERROR = 'MEMORY_ERROR', // No retry
  
  // Processing errors
  PARSE_ERROR = 'PARSE_ERROR', // No retry
  VALIDATION_ERROR = 'VALIDATION_ERROR', // No retry
  
  UNKNOWN = 'UNKNOWN'        // Retry once
}

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.NOT_PDF]: 'Only PDF files are supported',
  [ErrorCode.TOO_LARGE]: 'File exceeds 50 MB limit',
  [ErrorCode.INVALID_MAPPING]: 'Invalid mapping configuration',
  [ErrorCode.GW_4XX]: 'Invalid file format or configuration',
  [ErrorCode.GW_5XX]: 'Converter service error - will retry automatically',
  [ErrorCode.GW_TIMEOUT]: 'Processing timeout - will retry automatically',
  [ErrorCode.GW_UNAVAILABLE]: 'Service temporarily unavailable - will retry',
  [ErrorCode.IO_ERROR]: 'Storage error - will retry',
  [ErrorCode.MEMORY_ERROR]: 'Insufficient memory to process file',
  [ErrorCode.PARSE_ERROR]: 'Unable to parse PDF content',
  [ErrorCode.VALIDATION_ERROR]: 'Invalid PDF structure',
  [ErrorCode.UNKNOWN]: 'Unexpected error occurred'
};

export const RETRYABLE_ERRORS = new Set([
  ErrorCode.GW_5XX,
  ErrorCode.GW_TIMEOUT,
  ErrorCode.GW_UNAVAILABLE,
  ErrorCode.IO_ERROR,
  ErrorCode.UNKNOWN
]);
```

### 4.2 Retry Logic with Exponential Backoff
```typescript
// services/worker/src/retry.ts
export class RetryPolicy {
  private readonly maxAttempts: number;
  private readonly baseDelay: number;
  private readonly maxDelay: number;
  private readonly jitterRange: number;

  constructor(config?: {
    maxAttempts?: number;
    baseDelay?: number;
    maxDelay?: number;
    jitterRange?: number;
  }) {
    this.maxAttempts = config?.maxAttempts || 3;
    this.baseDelay = config?.baseDelay || 5000;
    this.maxDelay = config?.maxDelay || 60000;
    this.jitterRange = config?.jitterRange || 0.2;
  }

  shouldRetry(errorCode: string, attemptCount: number): boolean {
    if (attemptCount >= this.maxAttempts) {
      return false;
    }
    return RETRYABLE_ERRORS.has(errorCode as ErrorCode);
  }

  calculateDelay(attemptCount: number): number {
    // Exponential backoff: delay = base * 2^attempt
    const exponentialDelay = this.baseDelay * Math.pow(2, attemptCount - 1);
    
    // Cap at maxDelay
    const cappedDelay = Math.min(exponentialDelay, this.maxDelay);
    
    // Add jitter (±20% by default)
    const jitter = cappedDelay * this.jitterRange * (Math.random() * 2 - 1);
    
    return Math.round(cappedDelay + jitter);
  }
  
  getRetryAfter(attemptCount: number): Date {
    const delayMs = this.calculateDelay(attemptCount);
    return new Date(Date.now() + delayMs);
  }
}
```

### 4.3 Circuit Breaker Implementation
```typescript
// services/worker/src/circuitBreaker.ts
export enum CircuitState {
  CLOSED = 'CLOSED',  // Normal operation
  OPEN = 'OPEN',      // Failing, reject requests
  HALF_OPEN = 'HALF_OPEN' // Testing recovery
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private lastFailureTime?: Date;
  private nextAttemptTime?: Date;
  
  constructor(
    private readonly threshold: number = 5,
    private readonly timeout: number = 60000,
    private readonly halfOpenRequests: number = 3
  ) {}
  
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttemptTime?.getTime()) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.state = CircuitState.HALF_OPEN;
      this.successes = 0;
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  private onSuccess(): void {
    this.failures = 0;
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.halfOpenRequests) {
        this.state = CircuitState.CLOSED;
        logger.info('Circuit breaker closed');
      }
    }
  }
  
  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = new Date();
    
    if (this.failures >= this.threshold) {
      this.state = CircuitState.OPEN;
      this.nextAttemptTime = new Date(Date.now() + this.timeout);
      logger.warn(`Circuit breaker opened until ${this.nextAttemptTime}`);
    }
  }
  
  getState(): { 
    state: CircuitState; 
    failures: number; 
    nextAttemptTime?: Date 
  } {
    return {
      state: this.state,
      failures: this.failures,
      nextAttemptTime: this.nextAttemptTime
    };
  }
}
```

### 4.4 Enhanced Worker with Retry and Circuit Breaker
```typescript
// services/worker/src/processor.ts
import { RetryPolicy } from './retry';
import { CircuitBreaker } from './circuitBreaker';

const retryPolicy = new RetryPolicy({
  maxAttempts: parseInt(process.env.RETRY_MAX_ATTEMPTS || '3'),
  baseDelay: parseInt(process.env.RETRY_BASE_DELAY || '5000'),
  maxDelay: parseInt(process.env.RETRY_MAX_DELAY || '60000')
});

const circuitBreaker = new CircuitBreaker(
  parseInt(process.env.CIRCUIT_THRESHOLD || '5'),
  parseInt(process.env.CIRCUIT_TIMEOUT || '60000')
);

export async function processJobWithRetry(job: Job) {
  try {
    // Check if retry is scheduled for future
    if (job.retryAfter && new Date(job.retryAfter) > new Date()) {
      logger.info(`Job ${job.id} retry scheduled for ${job.retryAfter}`);
      return; // Skip for now
    }
    
    // Try to process through circuit breaker
    await circuitBreaker.execute(async () => {
      await processJobCore(job);
    });
    
  } catch (error) {
    const errorCode = mapErrorToCode(error);
    
    if (retryPolicy.shouldRetry(errorCode, job.attemptCount + 1)) {
      await scheduleRetry(job, errorCode, error.message);
    } else {
      await markJobFailed(job, errorCode, error.message, true); // dead letter
    }
  }
}

async function processJobCore(job: Job) {
  logger.info(`Processing job ${job.id} (attempt ${job.attemptCount + 1})`);
  
  // Extend lease periodically for long jobs
  const leaseExtender = startLeaseExtension(job.id);
  
  try {
    const xmlContent = await callGatewayWithTimeout(
      job.uploadPath!,
      job.mapping,
      GATEWAY_TIMEOUT
    );
    
    const resultPath = `results/${job.id}.xml`;
    await saveResultAtomic(resultPath, xmlContent);
    
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'complete',
        resultPath,
        completedAt: new Date(),
        leasedBy: null,
        leaseExpiresAt: null,
        attemptCount: job.attemptCount + 1
      }
    });
    
    logger.info(`Job ${job.id} completed successfully`);
    
  } finally {
    leaseExtender.stop();
  }
}

async function scheduleRetry(job: Job, errorCode: string, errorMessage: string) {
  const nextAttempt = job.attemptCount + 1;
  const retryAfter = retryPolicy.getRetryAfter(nextAttempt);
  
  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: 'queued', // Back to queue
      errorCode,
      errorMessage,
      lastAttemptAt: new Date(),
      retryAfter,
      attemptCount: nextAttempt,
      leasedBy: null,
      leaseExpiresAt: null
    }
  });
  
  logger.info(`Job ${job.id} scheduled for retry at ${retryAfter}`);
}

function startLeaseExtension(jobId: string) {
  const interval = setInterval(async () => {
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000)
        }
      });
    } catch (error) {
      logger.error(`Failed to extend lease for ${jobId}:`, error);
    }
  }, 30000); // Extend every 30 seconds
  
  return {
    stop: () => clearInterval(interval)
  };
}
```

### 4.5 Manual Retry API
```typescript
// app/api/jobs/[id]/retry/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withSession } from '@/lib/session';

export const POST = withSession(async (
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
      { error: { code: 'FORBIDDEN', message: 'Not authorized' } },
      { status: 403 }
    );
  }
  
  if (job.status !== 'failed') {
    return NextResponse.json(
      { error: { code: 'INVALID_STATE', message: 'Only failed jobs can be retried' } },
      { status: 409 }
    );
  }
  
  // Check if source file still exists
  if (!job.uploadPath || !existsSync(job.uploadPath)) {
    return NextResponse.json(
      { error: { code: 'FILE_NOT_FOUND', message: 'Source file no longer exists' } },
      { status: 404 }
    );
  }
  
  // Reset job for retry
  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: 'queued',
      queuedAt: new Date(),
      errorCode: null,
      errorMessage: null,
      retryAfter: null,
      attemptCount: 0, // Reset attempts for manual retry
      lastAttemptAt: null,
      failedAt: null
    }
  });
  
  return NextResponse.json({
    message: 'Job queued for retry',
    job: {
      id: job.id,
      status: 'queued'
    }
  });
});
```

### 4.6 UI Retry Button
```typescript
// components/queue/JobList.tsx (enhanced)
export function JobList({ jobs, onDownload, onRetry }) {
  return (
    <div className="space-y-4">
      {jobs.map(job => (
        <div key={job.id} className="bg-white rounded-lg shadow p-4">
          {/* ... existing content ... */}
          
          <div className="flex gap-2">
            {/* Review button (disabled) */}
            
            {/* Download button */}
            <button
              onClick={() => onDownload(job.id)}
              disabled={!job.canDownload}
              className={/* ... */}
            >
              Download
            </button>
            
            {/* Retry button for failed jobs */}
            {job.status === 'failed' && (
              <button
                onClick={() => onRetry(job.id)}
                className="px-3 py-1 text-sm rounded border border-orange-500 text-orange-600 hover:bg-orange-50"
              >
                Retry
              </button>
            )}
          </div>
          
          {/* Show retry info */}
          {job.attemptCount > 0 && job.status !== 'complete' && (
            <div className="mt-2 text-xs text-gray-500">
              Attempt {job.attemptCount} of {MAX_ATTEMPTS}
              {job.retryAfter && (
                <span> • Next retry: {formatRelativeTime(job.retryAfter)}</span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

### 4.7 Database Schema Updates
```prisma
// prisma/schema.prisma (additions)
model Job {
  // ... existing fields ...
  
  lastAttemptAt   DateTime? @map("last_attempt_at")
  retryAfter      DateTime? @map("retry_after")
  isDeadLetter    Boolean   @default(false) @map("is_dead_letter")
  
  @@index([retryAfter])
  @@index([status, retryAfter])
}
```

## 5. Test Plan

### 5.1 Unit Tests
```typescript
// __tests__/retry.test.ts
describe('RetryPolicy', () => {
  test('Exponential backoff calculation', () => {
    const policy = new RetryPolicy({ baseDelay: 1000 });
    expect(policy.calculateDelay(1)).toBeCloseTo(1000, -2);
    expect(policy.calculateDelay(2)).toBeCloseTo(2000, -2);
    expect(policy.calculateDelay(3)).toBeCloseTo(4000, -2);
  });
  
  test('Should retry only retryable errors', () => {
    const policy = new RetryPolicy();
    expect(policy.shouldRetry('GW_5XX', 1)).toBe(true);
    expect(policy.shouldRetry('GW_4XX', 1)).toBe(false);
  });
});

// __tests__/circuitBreaker.test.ts
describe('CircuitBreaker', () => {
  test('Opens after threshold failures', async () => {
    const cb = new CircuitBreaker(3, 1000);
    
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(() => Promise.reject('error'))).rejects.toThrow();
    }
    
    expect(cb.getState().state).toBe('OPEN');
  });
  
  test('Transitions to half-open after timeout', async () => {
    // Test state transition
  });
});
```

### 5.2 Integration Tests
```typescript
// __tests__/integration/retry-flow.test.ts
describe('Retry Flow', () => {
  test('Job retries on gateway timeout', async () => {
    // Mock gateway timeout
    // Process job
    // Verify retry scheduled
    // Process again
    // Verify success
  });
  
  test('Manual retry resets failed job', async () => {
    // Create failed job
    // Call retry API
    // Verify job queued
    // Verify attempt count reset
  });
  
  test('Circuit breaker prevents cascade', async () => {
    // Force multiple failures
    // Verify circuit opens
    // New jobs marked failed immediately
  });
});
```

### 5.3 Manual Test Checklist
- [ ] Gateway returns 502 → job retries with backoff
- [ ] Gateway timeout → job retries up to 3 times
- [ ] After 3 failures → job marked permanently failed
- [ ] Manual retry button → appears for failed jobs
- [ ] Click retry → job returns to queue
- [ ] Circuit breaker opens → warning in UI
- [ ] Retry info shows → "Attempt 2 of 3"
- [ ] Long job (>5min) → lease extended, completes successfully
- [ ] Kill worker during retry → job picked up again
- [ ] Concurrent jobs → limited by WORKER_CONCURRENCY

## 6. Exit Criteria

### Functional Requirements Met
- [x] Automatic retry with exponential backoff
- [x] Circuit breaker prevents cascade failures
- [x] Manual retry API and UI button
- [x] Enhanced error taxonomy with clear messages
- [x] Concurrent processing controls
- [x] Timeout handling with proper cleanup
- [x] Lease extension for long jobs
- [x] Dead letter marking for permanent failures

### Quality Metrics
- [ ] All unit tests passing (>85% coverage)
- [ ] Integration tests verify retry flows
- [ ] Manual testing checklist complete
- [ ] No retry storms detected
- [ ] Circuit breaker properly protects gateway

### Performance Baseline
- [ ] Retry delays follow exponential curve
- [ ] Circuit breaker opens < 100ms after threshold
- [ ] Lease extension overhead < 1% CPU
- [ ] Manual retry response < 200ms

### Documentation
- [ ] Error codes and messages documented
- [ ] Retry policy explained
- [ ] Circuit breaker thresholds documented
- [ ] Troubleshooting guide updated

## Success Indicators
- System gracefully handles gateway failures
- Users can manually retry failed jobs
- No cascade failures during outages
- Clear error messages guide user actions
- System ready for Phase 5 (production polish)