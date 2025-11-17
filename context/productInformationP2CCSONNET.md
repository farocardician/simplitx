## Phase 2 Development Plan: Review Page with Read-Only Suggestions

### Overview
Phase 2 adds a read-only Review interface that displays line items with suggested values from the `productInformation` table, showing the state of each field (match/mismatch/missing) without allowing edits.

---

## Step 1: Create Review Page Infrastructure

### 1.1 Add Review Route and Page Component

**Location:** `services/web/app/review/[id]/page.tsx`

Create a dynamic route for the review page:
```typescript
// Basic page structure with job ID from params
// Server component to fetch job and related data
// Pass data to client components for rendering
```

### 1.2 Create Review API Endpoint

**Location:** `services/web/app/api/jobs/[id]/review/route.ts`

Create endpoint to fetch review data:
- Load job details including parsed JSON from `resultPath`
- Extract vendor information from parsed data
- Batch query productInformation for suggestions
- Return structured data for UI consumption

---

## Step 2: Data Fetching Layer

### 2.1 Create Data Service Functions

**Location:** `services/web/lib/review-service.ts`

```typescript
// Core functions needed:
async function getJobWithParsedData(jobId: string)
async function extractVendorFromJob(parsedData: any): Promise<string>
async function getProductSuggestions(vendorId: string, items: Array<{sku?: string, description: string}>)
async function computeFieldStates(jsonValue: any, dbSuggestion: any)
```

### 2.2 Implement Lookup Precedence

Follow the documented order:
1. Try `(vendorId, sku)` when SKU exists
2. Fallback to `(vendorId, description)`
3. Use batch queries to avoid N+1 problem

**Query optimization example:**
```typescript
// Batch query for all items at once
const suggestions = await prisma.productInformation.findMany({
  where: {
    OR: [
      // SKU matches
      { vendorId, sku: { in: skuList } },
      // Description matches
      { vendorId, description: { in: descriptionList } }
    ]
  },
  include: {
    uom: true,
    vendor: true
  }
});
```

---

## Step 3: State Computation Logic

### 3.1 Define State Types

**Location:** `services/web/types/review.ts`

```typescript
enum FieldState {
  EXACT_MATCH = 'match',        // Green
  MISMATCH = 'mismatch',        // Amber
  ONLY_JSON = 'json_only',      // Blue
  ONLY_DB = 'db_only',          // Purple
  BOTH_MISSING = 'missing'      // Gray
}

interface FieldComparison {
  field: 'hsCode' | 'uomCode' | 'optCode';
  jsonValue: string | null;
  dbValue: string | null;
  state: FieldState;
  displayValue: string;
}
```

### 3.2 Implement State Calculator

**Location:** `services/web/lib/review-state.ts`

Compare logic for each field:
```typescript
function computeFieldState(jsonValue: string | null, dbValue: string | null): FieldState {
  if (jsonValue && dbValue) {
    return jsonValue === dbValue ? FieldState.EXACT_MATCH : FieldState.MISMATCH;
  }
  if (jsonValue && !dbValue) return FieldState.ONLY_JSON;
  if (!jsonValue && dbValue) return FieldState.ONLY_DB;
  return FieldState.BOTH_MISSING;
}
```

---

## Step 4: UI Components

### 4.1 Create Review Layout Component

**Location:** `services/web/app/review/[id]/ReviewLayout.tsx`

Header section showing:
- Invoice number
- Invoice date
- Vendor name
- Total items count
- Back to Queue button

### 4.2 Create Line Item Card Component

**Location:** `services/web/app/review/[id]/components/ItemCard.tsx`

Card structure:
```typescript
interface ItemCardProps {
  item: {
    no: number;
    description: string;
    sku?: string;
    qty: number;
    unitPrice: number;
    amount: number;
  };
  suggestions: {
    hsCode: FieldComparison;
    uomCode: FieldComparison;
    optCode: FieldComparison;
  };
}
```

Display elements:
- Item details (description, qty, prices)
- Three fields with state badges
- Visual indicators using Tailwind classes

### 4.3 Create State Badge Component

**Location:** `services/web/app/review/[id]/components/StateBadge.tsx`

Color mapping:
```typescript
const stateColors = {
  match: 'bg-green-100 text-green-800',      // Exact Match
  mismatch: 'bg-amber-100 text-amber-800',   // Mismatch
  json_only: 'bg-blue-100 text-blue-800',    // Only JSON
  db_only: 'bg-purple-100 text-purple-800',  // Only DB
  missing: 'bg-gray-100 text-gray-600'       // Both Missing
};
```

---

## Step 5: Queue Integration

### 5.1 Add Review Button to Queue

**Location:** `services/web/app/queue/components/ActionButtons.tsx`

Update the component to include Review button:
```typescript
// Add alongside existing Download/Delete buttons
<button
  onClick={() => window.open(`/review/${jobId}`, '_blank')}
  className="action-button bg-blue-600 hover:bg-blue-700 text-white"
  disabled={status !== 'complete'}
>
  Review
</button>
```

### 5.2 Ensure Button Only Shows for Complete Jobs

Only enable Review for jobs where:
- Status is 'complete'
- resultPath exists
- JSON data is available

---

## Step 6: Data Loading Strategy

### 6.1 Parse Existing Result Files

**Location:** `services/web/lib/file-parser.ts`

Read and parse the JSON from job's result:
```typescript
async function loadJobResult(job: Job) {
  // The job stores paths to files
  // We need to read the original parsed JSON
  // This might be in the artifact ZIP or a separate JSON file
  
  // Option 1: If stored as separate JSON
  if (job.resultPath) {
    const jsonPath = job.resultPath.replace('.xml', '.json');
    // Read and parse
  }
  
  // Option 2: Extract from artifact ZIP
  if (job.artifactPath) {
    // Unzip and find the final.json
  }
}
```

### 6.2 Handle Vendor Resolution

Extract vendor from parsed data:
- Check `seller.name` field in JSON
- Match against vendors table (case-insensitive)
- Create vendor if not exists (for new invoices)

---

## Step 7: Error Handling

### 7.1 Handle Missing Data Gracefully

- Job not found → redirect to Queue with message
- Parsed JSON unavailable → show error state
- Vendor not in DB → create on-the-fly or show warning
- No suggestions found → show all fields as "missing" state

### 7.2 Loading States

Add loading skeletons while fetching:
- Job data loading
- Suggestions loading
- Use React Suspense boundaries where appropriate

---

## Step 8: Testing Strategy

### 8.1 Create Test Data

**Script:** `services/web/scripts/seed-review-test.ts`

1. Create a completed job with known resultPath
2. Insert matching productInformation records
3. Create scenarios for each state type

### 8.2 Manual Testing Checklist

- [ ] Review button appears only for completed jobs
- [ ] Review opens in new tab
- [ ] Header shows correct invoice details
- [ ] Items display with all fields
- [ ] State badges show correct colors
- [ ] Match state (green) when values align
- [ ] Mismatch state (amber) when different
- [ ] Only JSON state (blue) for new items
- [ ] Only DB state (purple) for suggestions
- [ ] Missing state (gray) when no data
- [ ] SKU lookup takes precedence over description
- [ ] Performance acceptable for 50+ items

### 8.3 Verify No Side Effects

- [ ] Queue still works exactly as before
- [ ] XML download unchanged
- [ ] Artifact download unchanged
- [ ] No database writes from Review page
- [ ] No modifications to job status

---

## Step 9: Performance Optimizations

### 9.1 Batch Database Queries

Instead of N queries for N items:
```typescript
// Single query with OR conditions
const allSuggestions = await prisma.productInformation.findMany({
  where: {
    vendorId,
    OR: items.map(item => ({
      OR: [
        { sku: item.sku || undefined },
        { description: item.description }
      ]
    }))
  }
});

// Then map results to items in memory
```

### 9.2 Implement Caching

- Cache vendor lookups per session
- Cache UOM code mappings (rarely change)
- Use React Query or SWR for client-side caching

---

## Step 10: Documentation

### 10.1 Add README for Review Feature

**Location:** `services/web/app/review/README.md`

Document:
- Purpose of Review page
- State definitions and colors
- Lookup precedence rules
- How to test the feature

### 10.2 Update API Documentation

Document new endpoints:
- GET `/api/jobs/[id]/review` - Fetch review data
- Response schema with suggestions and states

---

## Implementation Order

1. **Day 1**: Create page route, API endpoint, basic data fetching
2. **Day 2**: Implement state computation logic and UI components
3. **Day 3**: Add Review button to Queue, wire up navigation
4. **Day 4**: Handle edge cases, error states, loading states
5. **Day 5**: Testing, performance optimization, documentation

---

## Acceptance Criteria

- [ ] Review page accessible via new tab from Queue
- [ ] Shows invoice header (number, date, vendor, count)
- [ ] Displays one card per line item
- [ ] Each card shows description, qty, unit_price, amount
- [ ] Three fields (HS/UOM/Type) display with state badges
- [ ] Five states rendered with correct colors
- [ ] Lookup uses (vendorId, sku) then (vendorId, description)
- [ ] Page is completely read-only (no edits possible)
- [ ] Queue and XML downloads remain unchanged
- [ ] Performance acceptable for typical invoice (20-50 items)
- [ ] No errors for missing suggestions or new vendors

This plan provides a safe, incremental addition of the Review interface without disrupting existing functionality, setting the stage for Phase 3's edit and save capabilities.