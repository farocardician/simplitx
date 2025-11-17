## Phase 3 Development Plan: Edit, Save, and Approve Functionality

### Overview
Phase 3 transforms the read-only Review page into an interactive editing interface, enabling reviewers to save corrections to `productInformation` and approve invoices to generate final XML.

---

## Step 1: Add Edit Controls to Review Page

### 1.1 Update ItemCard Component for Editing

**Location:** `services/web/app/review/[id]/components/ItemCard.tsx`

Transform read-only fields to controlled inputs:

```typescript
interface ItemCardProps {
  // ... existing props
  onFieldChange: (itemIndex: number, field: string, value: string) => void;
  onSave: (itemIndex: number) => Promise<void>;
  isDirty: boolean;
  isSaving: boolean;
}

// Add state management for editable fields
const [editedValues, setEditedValues] = useState({
  descriptionNormalized: item.description,
  sku: item.sku || '',
  hsCode: suggestions.hsCode.displayValue,
  uomCode: suggestions.uomCode.displayValue,
  optCode: suggestions.optCode.displayValue
});
```

### 1.2 Create UOM Dropdown Component

**Location:** `services/web/app/review/[id]/components/UomDropdown.tsx`

```typescript
interface UomDropdownProps {
  value: string;
  onChange: (code: string) => void;
  uomList: Array<{ code: string; name: string }>;
  disabled?: boolean;
}

// Display format: "name (code)" e.g., "Piece (UM.0021)"
// Store only the code value
```

### 1.3 Create Type Dropdown Component

**Location:** `services/web/app/review/[id]/components/TypeDropdown.tsx`

Simple dropdown with two options:
- Barang (Goods)
- Jasa (Service)

---

## Step 2: Implement Dirty/Clean State Management

### 2.1 Create State Manager Hook

**Location:** `services/web/hooks/useReviewState.ts`

```typescript
interface CardState {
  originalValues: Record<string, any>;
  currentValues: Record<string, any>;
  isDirty: boolean;
  isSaving: boolean;
  savedAt?: Date;
}

export function useReviewState(items: any[]) {
  const [cardStates, setCardStates] = useState<CardState[]>([]);
  
  const updateField = (index: number, field: string, value: string) => {
    // Update currentValues
    // Compare with originalValues to set isDirty
  };
  
  const markClean = (index: number, savedValues: any) => {
    // Update originalValues to savedValues
    // Set isDirty = false
  };
  
  const allClean = () => cardStates.every(card => !card.isDirty);
  
  return { cardStates, updateField, markClean, allClean };
}
```

### 2.2 Update Field State Definitions

**Location:** `services/web/types/review.ts`

Add editing states:
```typescript
enum FieldState {
  // ... existing states
  EDITED = 'edited',    // Orange - user modified
  SAVED = 'saved'       // Green check - recently saved
}
```

---

## Step 3: Save API Implementation

### 3.1 Create Save Endpoint

**Location:** `services/web/app/api/review/save/route.ts`

```typescript
export async function POST(request: Request) {
  const data = await request.json();
  const {
    jobId,
    lineIndex,
    vendorId,
    sku,
    description,
    descriptionNormalized,
    uomCode,
    optCode,
    hsCode
  } = data;
  
  // Validate UOM exists
  const uomExists = await prisma.uom.findUnique({
    where: { code: uomCode }
  });
  
  if (!uomExists) {
    return NextResponse.json(
      { error: 'Invalid UOM code' },
      { status: 400 }
    );
  }
  
  // Determine key: prefer (vendorId, sku) else (vendorId, description)
  const upsertKey = sku 
    ? { vendorId_sku: { vendorId, sku } }
    : { vendorId_description: { vendorId, description } };
  
  // Upsert to productInformation
  const saved = await prisma.productInformation.upsert({
    where: upsertKey,
    update: {
      descriptionNormalized,
      uomCode,
      optCode,
      hsCode,
      updatedAt: new Date()
    },
    create: {
      vendorId,
      sku,
      description,
      descriptionNormalized,
      uomCode,
      optCode,
      hsCode
    },
    include: {
      uom: true
    }
  });
  
  // Log the save action
  await logReviewAction(jobId, lineIndex, 'save', userId);
  
  return NextResponse.json({
    success: true,
    saved: {
      ...saved,
      uomDisplay: `${saved.uom.name} (${saved.uom.code})`
    }
  });
}
```

### 3.2 Add Save Function to Review Page

**Location:** `services/web/app/review/[id]/components/ItemCard.tsx`

```typescript
const handleSave = async () => {
  setIsSaving(true);
  
  try {
    const response = await fetch('/api/review/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId,
        lineIndex: itemIndex,
        vendorId,
        sku: editedValues.sku,
        description: item.description, // Original
        descriptionNormalized: editedValues.descriptionNormalized,
        uomCode: editedValues.uomCode,
        optCode: editedValues.optCode,
        hsCode: editedValues.hsCode
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      onSaveSuccess(itemIndex, data.saved);
      showToast('Saved ✓', 'success');
    }
  } catch (error) {
    showToast('Save failed', 'error');
  } finally {
    setIsSaving(false);
  }
};
```

---

## Step 4: Field Validation

### 4.1 Create Validation Utils

**Location:** `services/web/lib/validation.ts`

```typescript
export const validateHsCode = (value: string): boolean => {
  if (!value) return true; // Allow empty
  return /^\d+$/.test(value); // Digits only
};

export const validateUomCode = (value: string, validCodes: string[]): boolean => {
  return validCodes.includes(value);
};

export const validateOptCode = (value: string): boolean => {
  return ['A', 'B'].includes(value); // Barang/Jasa mapping
};
```

### 4.2 Add Inline Validation

Show validation errors immediately:
```typescript
const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

const handleFieldChange = (field: string, value: string) => {
  // Clear error first
  setFieldErrors(prev => ({ ...prev, [field]: '' }));
  
  // Validate
  if (field === 'hsCode' && !validateHsCode(value)) {
    setFieldErrors(prev => ({ ...prev, hsCode: 'Must be numeric' }));
  }
  
  // Update value
  updateField(itemIndex, field, value);
};
```

---

## Step 5: Approve Implementation

### 5.1 Create Approve Endpoint

**Location:** `services/web/app/api/review/approve/route.ts`

```typescript
export async function POST(request: Request) {
  const { jobId } = await request.json();
  
  // Get job details
  const job = await prisma.job.findUnique({
    where: { id: jobId }
  });
  
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  
  if (job.approved) {
    return NextResponse.json({ error: 'Already approved' }, { status: 400 });
  }
  
  // Load parsed invoice data
  const invoiceData = await loadParsedInvoice(job);
  const vendorId = await resolveVendor(invoiceData);
  
  // Fetch all saved values from productInformation
  const savedItems = await fetchSavedItems(vendorId, invoiceData.items);
  
  // Generate approved XML using saved values
  const approvedXml = await generateApprovedXml(invoiceData, savedItems);
  
  // Save to resultPath (overwrite existing)
  await fs.writeFile(job.resultPath, approvedXml);
  
  // Update job status
  await prisma.job.update({
    where: { id: jobId },
    data: {
      approved: true,
      approvedAt: new Date()
    }
  });
  
  // Log approval
  await logReviewAction(jobId, null, 'approve', userId);
  
  return NextResponse.json({ 
    success: true,
    redirectUrl: '/queue'
  });
}
```

### 5.2 Create XML Generation Service

**Location:** `services/web/lib/xml-generator.ts`

```typescript
export async function generateApprovedXml(
  invoiceData: any,
  savedItems: ProductInformation[]
): Promise<string> {
  // Map saved values to invoice items
  const enrichedItems = invoiceData.items.map((item, index) => {
    const saved = savedItems[index];
    return {
      ...item,
      hs_code: saved?.hsCode || item.hs_code,
      uom: saved?.uomCode || item.uom,
      opt_code: saved?.optCode || item.opt_code
    };
  });
  
  // Call existing JSON to XML converter
  const response = await fetch(process.env.JSON2XML_URL + '/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...invoiceData,
      items: enrichedItems
    })
  });
  
  return await response.text();
}
```

---

## Step 6: Review Page Integration

### 6.1 Add Approve Button and Logic

**Location:** `services/web/app/review/[id]/page.tsx`

```typescript
const ReviewPage = () => {
  const { cardStates, allClean } = useReviewState(items);
  const [isApproving, setIsApproving] = useState(false);
  
  const handleApprove = async () => {
    if (!allClean()) {
      showToast('Please save all changes first', 'warning');
      return;
    }
    
    setIsApproving(true);
    
    try {
      const response = await fetch('/api/review/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId })
      });
      
      if (response.ok) {
        const { redirectUrl } = await response.json();
        window.location.href = redirectUrl; // Navigate in same tab
      }
    } catch (error) {
      showToast('Approval failed', 'error');
    } finally {
      setIsApproving(false);
    }
  };
  
  return (
    <>
      {/* Item cards */}
      <button
        onClick={handleApprove}
        disabled={!allClean() || isApproving}
        className={`
          ${allClean() ? 'bg-green-600' : 'bg-gray-400'}
          text-white px-6 py-2 rounded
        `}
      >
        {isApproving ? 'Approving...' : 'Approve Invoice'}
      </button>
    </>
  );
};
```

---

## Step 7: Visual Feedback

### 7.1 Create Toast Notification System

**Location:** `services/web/components/Toast.tsx`

Simple toast for save/error feedback:
```typescript
export function showToast(message: string, type: 'success' | 'error' | 'warning') {
  // Implementation using React Context or library like react-hot-toast
}
```

### 7.2 Add Save Indicator

Show micro-feedback on successful save:
```typescript
// In ItemCard after successful save
<span className="text-green-600 text-sm animate-fade-in">
  Saved ✓
</span>
```

---

## Step 8: Audit Logging

### 8.1 Create Audit Log Table

**Location:** `services/web/prisma/schema.prisma`

```prisma
model ReviewLog {
  id          String   @id @default(uuid())
  jobId       String   @map("job_id")
  lineIndex   Int?     @map("line_index")
  action      String   // 'save' | 'approve'
  userId      String   @map("user_id")
  metadata    Json?
  createdAt   DateTime @default(now()) @map("created_at")
  
  @@index([jobId])
  @@map("review_logs")
}
```

### 8.2 Implement Logging Function

**Location:** `services/web/lib/audit.ts`

```typescript
export async function logReviewAction(
  jobId: string,
  lineIndex: number | null,
  action: 'save' | 'approve',
  userId: string,
  metadata?: any
) {
  await prisma.reviewLog.create({
    data: {
      jobId,
      lineIndex,
      action,
      userId,
      metadata
    }
  });
}
```

---

## Step 9: Performance Optimizations

### 9.1 Batch Fetch for Approve

When generating approved XML, fetch all items at once:
```typescript
const savedItems = await prisma.productInformation.findMany({
  where: {
    vendorId,
    OR: items.map(item => ({
      OR: [
        { sku: item.sku || undefined },
        { description: item.description }
      ]
    }))
  },
  include: { uom: true }
});
```

### 9.2 Cache UOM List

Load UOM list once and reuse:
```typescript
// In Review page
const uomList = useMemo(() => 
  fetchUomList(), // Fetch once
  []
);
```

---

## Step 10: Testing Checklist

### 10.1 Edit and Save Flow
- [ ] Edit field → card shows Dirty state
- [ ] Save button enables only when Dirty
- [ ] Save shows loading state
- [ ] Success shows "Saved ✓" feedback
- [ ] Card returns to Clean state
- [ ] Field states update to reflect saved values

### 10.2 Validation
- [ ] HS Code accepts only numeric
- [ ] UOM dropdown shows "name (code)" format
- [ ] Invalid UOM code rejected on save
- [ ] Type dropdown has only two options

### 10.3 Approve Flow
- [ ] Approve disabled when cards are Dirty
- [ ] Approve enabled when all Clean
- [ ] Approve shows loading state
- [ ] Successful approve redirects to Queue
- [ ] Queue shows Approved = Yes
- [ ] XML download serves approved content

### 10.4 Edge Cases
- [ ] Concurrent edits handled gracefully
- [ ] Already approved invoices show error
- [ ] Missing vendor creates new vendor record
- [ ] Empty optional fields allowed

---

## Implementation Order

1. **Day 1**: Add edit controls and state management
2. **Day 2**: Implement Save API and integration
3. **Day 3**: Add validation and error handling
4. **Day 4**: Implement Approve flow and XML generation
5. **Day 5**: Testing, polish, and audit logging

---

## Acceptance Criteria

- [ ] All fields editable except amount (calculated)
- [ ] UOM dropdown populated from database
- [ ] Dirty/Clean states work per card
- [ ] Save persists to productInformation with correct key
- [ ] Save button only enabled when Dirty
- [ ] Approve only enabled when all Clean
- [ ] Approve generates new XML to resultPath
- [ ] Queue shows Approved = Yes after approval
- [ ] XML download serves approved content
- [ ] Existing download endpoints unchanged
- [ ] Audit log captures all actions

This completes the implementation plan for Phase 3, transforming the Review page into a fully functional editing and approval system while maintaining backward compatibility with existing download mechanisms.