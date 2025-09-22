## Phase 4 Development Plan: Complete Save & Approve Implementation

### Overview
Phase 4 completes the review system by enabling full editing capabilities, persistent saves to `productInformation`, and approval workflow that regenerates XML and replaces the current draft.

---

## Step 1: Database Schema Updates

### 1.1 Add Review Status to Job Model

**Location:** `services/web/prisma/schema.prisma` and `services/worker/prisma/schema.prisma`

```prisma
model Job {
  // ... existing fields
  isApproved      Boolean   @default(false) @map("is_approved")
  approvedAt      DateTime? @map("approved_at")
  approvedBy      String?   @map("approved_by") // session ID or user ID
  // ... rest of model
}
```

### 1.2 Run Migration

```bash
npx prisma migrate dev --name add_review_status
```

---

## Step 2: API Implementation

### 2.1 GET Review Data Endpoint

**Location:** `services/web/app/api/review/[id]/route.ts`

```typescript
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const jobId = params.id;
  
  // Load job and verify access
  const job = await prisma.job.findUnique({
    where: { id: jobId }
  });
  
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  
  // Parse the JSON data (from artifacts or stored JSON)
  const invoiceData = await parseInvoiceData(job);
  
  // Extract vendor
  const vendorName = invoiceData.seller?.name;
  const vendor = await prisma.vendor.findFirst({
    where: { name: { mode: 'insensitive', equals: vendorName } }
  });
  
  if (!vendor) {
    // Create vendor on the fly
    const newVendor = await prisma.vendor.create({
      data: { name: vendorName }
    });
    vendor = newVendor;
  }
  
  // Batch fetch suggestions
  const suggestions = await fetchSuggestions(vendor.id, invoiceData.items);
  
  // Compute field states for each item
  const enrichedItems = invoiceData.items.map((item, index) => {
    const suggestion = suggestions[index];
    return {
      ...item,
      lineId: index,
      suggestion,
      fieldStates: computeFieldStates(item, suggestion)
    };
  });
  
  return NextResponse.json({
    jobId,
    vendorId: vendor.id,
    vendorName: vendor.name,
    invoice: {
      number: invoiceData.invoice?.number,
      date: invoiceData.invoice?.date
    },
    items: enrichedItems,
    isApproved: job.isApproved
  });
}
```

### 2.2 POST Save Line Endpoint

**Location:** `services/web/app/api/review/[id]/line/[lineId]/route.ts`

```typescript
export async function POST(
  request: Request,
  { params }: { params: { id: string; lineId: string } }
) {
  const jobId = params.id;
  const lineId = parseInt(params.lineId);
  const data = await request.json();
  
  const {
    vendorId,
    sku,
    description,
    descriptionNormalized,
    hsCode,
    uomCode,
    optCode,
    qty,
    unitPrice
  } = data;
  
  // Validate numeric fields
  if (qty && isNaN(parseFloat(qty))) {
    return NextResponse.json({ error: 'Qty must be numeric' }, { status: 400 });
  }
  
  if (unitPrice && isNaN(parseFloat(unitPrice))) {
    return NextResponse.json({ error: 'Unit price must be numeric' }, { status: 400 });
  }
  
  // Validate UOM exists
  if (uomCode) {
    const uomExists = await prisma.uom.findUnique({
      where: { code: uomCode }
    });
    
    if (!uomExists) {
      return NextResponse.json({ error: 'Invalid UOM code' }, { status: 400 });
    }
  }
  
  // Determine save key
  const saveKey = sku 
    ? { vendorId_sku: { vendorId, sku } }
    : { vendorId_description: { vendorId, description: descriptionNormalized || description } };
  
  // Upsert to productInformation
  const saved = await prisma.productInformation.upsert({
    where: saveKey,
    update: {
      descriptionNormalized,
      hsCode,
      uomCode,
      optCode,
      updatedAt: new Date()
    },
    create: {
      vendorId,
      sku: sku || null,
      description: descriptionNormalized || description,
      descriptionNormalized,
      hsCode,
      uomCode,
      optCode
    },
    include: {
      uom: true,
      vendor: true
    }
  });
  
  // Store qty/unitPrice separately if needed (for this specific invoice)
  // Could use a separate table or session storage
  await storeLineOverrides(jobId, lineId, { qty, unitPrice });
  
  return NextResponse.json({
    success: true,
    saved: {
      ...saved,
      uomDisplay: saved.uom ? `${saved.uom.name} (${saved.uom.code})` : null
    }
  });
}
```

### 2.3 POST Approve Endpoint

**Location:** `services/web/app/api/review/[id]/approve/route.ts`

```typescript
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const jobId = params.id;
  const { sessionId } = await getSession(request);
  
  // Check job exists and not already approved
  const job = await prisma.job.findUnique({
    where: { id: jobId }
  });
  
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  
  if (job.isApproved) {
    return NextResponse.json({ error: 'Invoice already approved' }, { status: 400 });
  }
  
  // Load invoice data
  const invoiceData = await parseInvoiceData(job);
  const vendor = await resolveVendor(invoiceData.seller?.name);
  
  // Fetch all saved values from productInformation
  const savedItems = await fetchAllSavedItems(vendor.id, invoiceData.items);
  
  // Get any line-specific overrides (qty, unitPrice)
  const lineOverrides = await getLineOverrides(jobId);
  
  // Merge saved values with original data
  const approvedItems = invoiceData.items.map((item, index) => {
    const saved = savedItems[index];
    const override = lineOverrides[index];
    
    return {
      ...item,
      // Use saved values if available
      hs_code: saved?.hsCode || item.hs_code,
      uom: saved?.uomCode || item.uom,
      opt_code: saved?.optCode || item.opt_code,
      description_normalized: saved?.descriptionNormalized || item.description,
      // Apply overrides if present
      qty: override?.qty || item.qty,
      unit_price: override?.unitPrice || item.unit_price,
      // Recalculate amount
      amount: (override?.qty || item.qty) * (override?.unitPrice || item.unit_price)
    };
  });
  
  // Generate approved XML
  const approvedXml = await generateXmlFromItems({
    ...invoiceData,
    items: approvedItems
  });
  
  // Backup draft XML if desired (optional)
  const draftPath = job.resultPath?.replace('.xml', '-draft.xml');
  if (draftPath && job.resultPath) {
    await fs.copyFile(job.resultPath, draftPath);
  }
  
  // Overwrite resultPath with approved XML
  if (job.resultPath) {
    await fs.writeFile(job.resultPath, approvedXml);
  }
  
  // Update job status
  await prisma.job.update({
    where: { id: jobId },
    data: {
      isApproved: true,
      approvedAt: new Date(),
      approvedBy: sessionId
    }
  });
  
  // Log approval action
  await logAction(jobId, 'approve', sessionId);
  
  return NextResponse.json({
    success: true,
    redirectUrl: '/queue'
  });
}
```

---

## Step 3: Review Page Implementation

### 3.1 Main Review Page Component

**Location:** `services/web/app/review/[id]/page.tsx`

```typescript
'use client';

import { useState, useEffect } from 'react';
import { ItemCard } from './components/ItemCard';
import { ReviewHeader } from './components/ReviewHeader';
import { ApproveButton } from './components/ApproveButton';

export default function ReviewPage({ params }: { params: { id: string } }) {
  const jobId = params.id;
  const [reviewData, setReviewData] = useState(null);
  const [cardStates, setCardStates] = useState<Map<number, boolean>>(new Map());
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    fetchReviewData();
  }, [jobId]);
  
  const fetchReviewData = async () => {
    const response = await fetch(`/api/review/${jobId}`);
    const data = await response.json();
    setReviewData(data);
    // Initialize all cards as clean
    const states = new Map();
    data.items.forEach((_, index) => states.set(index, false));
    setCardStates(states);
    setLoading(false);
  };
  
  const handleCardDirtyChange = (lineId: number, isDirty: boolean) => {
    setCardStates(prev => {
      const next = new Map(prev);
      next.set(lineId, isDirty);
      return next;
    });
  };
  
  const allClean = () => {
    return Array.from(cardStates.values()).every(isDirty => !isDirty);
  };
  
  if (loading) return <div>Loading...</div>;
  if (!reviewData) return <div>Error loading review data</div>;
  
  return (
    <div className="container mx-auto p-4">
      <ReviewHeader 
        invoice={reviewData.invoice}
        vendor={reviewData.vendorName}
        itemCount={reviewData.items.length}
      />
      
      <div className="space-y-4 mt-6">
        {reviewData.items.map((item, index) => (
          <ItemCard
            key={index}
            item={item}
            lineId={index}
            jobId={jobId}
            vendorId={reviewData.vendorId}
            onDirtyChange={(isDirty) => handleCardDirtyChange(index, isDirty)}
          />
        ))}
      </div>
      
      <ApproveButton
        jobId={jobId}
        enabled={allClean()}
        isApproved={reviewData.isApproved}
      />
    </div>
  );
}
```

### 3.2 Enhanced ItemCard Component

**Location:** `services/web/app/review/[id]/components/ItemCard.tsx`

```typescript
interface ItemCardProps {
  item: any;
  lineId: number;
  jobId: string;
  vendorId: string;
  onDirtyChange: (isDirty: boolean) => void;
}

export function ItemCard({ item, lineId, jobId, vendorId, onDirtyChange }: ItemCardProps) {
  const [values, setValues] = useState({
    descriptionNormalized: item.description,
    sku: item.sku || '',
    hsCode: item.fieldStates?.hsCode?.displayValue || '',
    uomCode: item.fieldStates?.uomCode?.displayValue || '',
    optCode: item.fieldStates?.optCode?.displayValue || '',
    qty: item.qty,
    unitPrice: item.unit_price
  });
  
  const [originalValues] = useState({ ...values });
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  
  const handleFieldChange = (field: string, value: any) => {
    setValues(prev => ({ ...prev, [field]: value }));
    
    // Check if dirty
    const dirty = JSON.stringify({ ...values, [field]: value }) !== JSON.stringify(originalValues);
    setIsDirty(dirty);
    onDirtyChange(dirty);
    setShowSaved(false);
  };
  
  const handleSave = async () => {
    setIsSaving(true);
    
    try {
      const response = await fetch(`/api/review/${jobId}/line/${lineId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorId,
          sku: values.sku,
          description: item.description,
          descriptionNormalized: values.descriptionNormalized,
          hsCode: values.hsCode,
          uomCode: values.uomCode,
          optCode: values.optCode,
          qty: values.qty,
          unitPrice: values.unitPrice
        })
      });
      
      if (response.ok) {
        setIsDirty(false);
        onDirtyChange(false);
        setShowSaved(true);
        // Update original values
        Object.assign(originalValues, values);
      }
    } finally {
      setIsSaving(false);
    }
  };
  
  // Calculate amount
  const amount = (parseFloat(values.qty) || 0) * (parseFloat(values.unitPrice) || 0);
  
  return (
    <div className={`border rounded-lg p-4 ${isDirty ? 'border-orange-400' : 'border-gray-200'}`}>
      <div className="grid grid-cols-2 gap-4">
        {/* Raw Description - Read Only */}
        <div>
          <label className="text-sm text-gray-600">Description (Original)</label>
          <div className="p-2 bg-gray-50 rounded">{item.description}</div>
        </div>
        
        {/* Normalized Description - Editable */}
        <div>
          <label className="text-sm text-gray-600">Description (Normalized)</label>
          <input
            type="text"
            value={values.descriptionNormalized}
            onChange={(e) => handleFieldChange('descriptionNormalized', e.target.value)}
            className="w-full p-2 border rounded"
          />
        </div>
        
        {/* SKU */}
        <div>
          <label className="text-sm text-gray-600">SKU</label>
          <input
            type="text"
            value={values.sku}
            onChange={(e) => handleFieldChange('sku', e.target.value)}
            className="w-full p-2 border rounded"
          />
        </div>
        
        {/* HS Code with State Badge */}
        <div>
          <label className="text-sm text-gray-600">
            HS Code
            <FieldStateBadge state={item.fieldStates?.hsCode?.state} />
          </label>
          <input
            type="text"
            value={values.hsCode}
            onChange={(e) => handleFieldChange('hsCode', e.target.value)}
            className="w-full p-2 border rounded"
            pattern="[0-9]*"
          />
        </div>
        
        {/* Qty - Editable */}
        <div>
          <label className="text-sm text-gray-600">Qty</label>
          <input
            type="number"
            value={values.qty}
            onChange={(e) => handleFieldChange('qty', e.target.value)}
            className="w-full p-2 border rounded"
          />
        </div>
        
        {/* Unit Price - Editable */}
        <div>
          <label className="text-sm text-gray-600">Unit Price</label>
          <input
            type="number"
            step="0.01"
            value={values.unitPrice}
            onChange={(e) => handleFieldChange('unitPrice', e.target.value)}
            className="w-full p-2 border rounded"
          />
        </div>
        
        {/* Amount - Calculated, Read Only */}
        <div>
          <label className="text-sm text-gray-600">Amount</label>
          <div className="p-2 bg-gray-50 rounded">
            {amount.toFixed(2)}
          </div>
        </div>
        
        {/* UOM Dropdown with State Badge */}
        <UomDropdown
          value={values.uomCode}
          onChange={(code) => handleFieldChange('uomCode', code)}
          state={item.fieldStates?.uomCode?.state}
        />
        
        {/* Type Dropdown with State Badge */}
        <TypeDropdown
          value={values.optCode}
          onChange={(code) => handleFieldChange('optCode', code)}
          state={item.fieldStates?.optCode?.state}
        />
      </div>
      
      <div className="flex justify-end mt-4 items-center gap-2">
        {showSaved && (
          <span className="text-green-600 text-sm">Saved ✓</span>
        )}
        <button
          onClick={handleSave}
          disabled={!isDirty || isSaving}
          className={`px-4 py-2 rounded ${
            isDirty 
              ? 'bg-blue-600 text-white hover:bg-blue-700' 
              : 'bg-gray-200 text-gray-400 cursor-not-allowed'
          }`}
        >
          {isSaving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}
```

---

## Step 4: Field State Components

### 4.1 Field State Badge

**Location:** `services/web/app/review/[id]/components/FieldStateBadge.tsx`

```typescript
const stateConfig = {
  match: { color: 'green', label: 'Match' },
  divergent: { color: 'amber', label: 'Divergent' },
  json_only: { color: 'blue', label: 'JSON Only' },
  db_only: { color: 'purple', label: 'DB Only' },
  missing: { color: 'gray', label: 'Missing' }
};

export function FieldStateBadge({ state }: { state: string }) {
  const config = stateConfig[state] || stateConfig.missing;
  
  return (
    <span className={`ml-2 px-2 py-1 text-xs rounded bg-${config.color}-100 text-${config.color}-800`}>
      {config.label}
    </span>
  );
}
```

---

## Step 5: Helper Functions

### 5.1 XML Generation Service

**Location:** `services/web/lib/xml-service.ts`

```typescript
export async function generateXmlFromItems(data: any): Promise<string> {
  // Call JSON2XML service with enriched data
  const response = await fetch(`${process.env.JSON2XML_URL}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  
  if (!response.ok) {
    throw new Error('Failed to generate XML');
  }
  
  return await response.text();
}
```

### 5.2 Data Parsing Service

**Location:** `services/web/lib/invoice-parser.ts`

```typescript
export async function parseInvoiceData(job: Job): Promise<any> {
  // Try to find the parsed JSON
  // Option 1: Check for JSON file alongside XML
  const jsonPath = job.resultPath?.replace('.xml', '.json');
  
  if (jsonPath && await fileExists(jsonPath)) {
    const content = await fs.readFile(jsonPath, 'utf-8');
    return JSON.parse(content);
  }
  
  // Option 2: Extract from artifacts
  if (job.artifactPath) {
    // Unzip and find final.json
    const extracted = await extractZip(job.artifactPath);
    const finalJson = extracted.find(f => f.name.endsWith('final.json'));
    if (finalJson) {
      return JSON.parse(finalJson.content);
    }
  }
  
  throw new Error('Unable to find parsed invoice data');
}
```

---

## Step 6: Queue Integration Update

### 6.1 Update Queue to Show Approved Status

**Location:** `services/web/app/queue/page.tsx`

The Approved column should already be showing from Phase 1. Just ensure it reads the `isApproved` field:

```typescript
// In the job mapping
const formattedJobs = jobs.map(job => ({
  ...job,
  approved: job.isApproved ? 'Yes' : 'No'
}));
```

---

## Step 7: Testing Plan

### 7.1 End-to-End Test Script

**Location:** `services/web/scripts/test-review-flow.ts`

```typescript
// 1. Create a test job with known data
// 2. Open Review page
// 3. Edit fields
// 4. Save each card
// 5. Approve
// 6. Verify XML changes
// 7. Check Queue shows Approved = Yes
```

### 7.2 Manual Testing Checklist

- [ ] Review page loads with all items
- [ ] Field states show correctly (Match/Divergent/etc)
- [ ] Edit any field → card becomes Dirty
- [ ] Save button enables only when Dirty
- [ ] Save shows "Saved ✓" feedback
- [ ] Approve disabled when any card is Dirty
- [ ] Approve enabled when all cards are Clean
- [ ] Approve redirects to Queue
- [ ] Queue shows Approved = Yes
- [ ] XML download serves approved content
- [ ] Bulk download includes approved XMLs

---

## Step 8: Error Handling

### 8.1 Validation Errors

```typescript
// In save endpoint
if (hsCode && !/^\d+$/.test(hsCode)) {
  return NextResponse.json(
    { error: 'HS Code must be numeric' },
    { status: 400 }
  );
}
```

### 8.2 Concurrency Protection

```typescript
// In approve endpoint
const job = await prisma.job.findUnique({
  where: { id: jobId }
});

if (job.isApproved) {
  return NextResponse.json(
    { error: 'Invoice already approved' },
    { status: 409 }
  );
}
```

---

## Implementation Timeline

1. **Day 1**: Schema updates, API endpoints
2. **Day 2**: Review page with editing capabilities
3. **Day 3**: Save functionality and field states
4. **Day 4**: Approve flow and XML generation
5. **Day 5**: Testing and polish

---

## Acceptance Criteria

- [ ] All fields editable (including qty, unit price)
- [ ] Field states visible (Match/Divergent/JSON Only/DB Only/Missing)
- [ ] Save persists to productInformation with correct key
- [ ] Dirty/Clean states work correctly
- [ ] Approve blocked when cards are Dirty
- [ ] Approve generates new XML to resultPath
- [ ] Existing XML button serves approved content
- [ ] Queue shows Approved = Yes
- [ ] No changes needed to download endpoints
- [ ] Bulk download automatically includes approved XMLs

This completes the Phase 4 implementation, providing full edit/save/approve functionality while maintaining backward compatibility with existing download mechanisms.