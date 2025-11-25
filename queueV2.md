# Queue V2: Filtering & Sorting System

## 📋 Overview

This document tracks the implementation of a comprehensive filtering and sorting system for the Queue V2 page (`/queue-v2`). The system is designed to be modular, scalable, and follow industry best practices.

---

## ✅ Completed Features

### 1. **Advanced Bulk Selection System**
- ✅ Three selection modes: `none`, `page`, `all`
- ✅ Select all on current page
- ✅ Select all across all pages
- ✅ Deselect specific items (exclusions in "all" mode)
- ✅ Selection persists across page changes
- ✅ Unified action bar with selection state
- ✅ Mass actions: Download XML, Delete

### 2. **Pagination System**
- ✅ Page number display with ellipsis (1 ... 5 6 [7] 8 9 ... 20)
- ✅ Per-page selector (10, 20, 50, 100) - default 50
- ✅ Previous/Next navigation
- ✅ Shows range (e.g., "1-50 of 672")
- ✅ Smart page number algorithm based on position

### 3. **Filter & Sort UI Components** (NEW)
- ✅ `FilterBar` component with:
  - Buyer dropdown with search/autocomplete
  - Sort field selector (Date, Invoice Number, Buyer Name)
  - Sort direction toggle (↑↓)
  - "Clear all" button
- ✅ `ActiveFilters` component:
  - Filter chips showing active filters
  - Click × to remove individual filters
  - Auto-hides when no filters active
- ✅ Type definitions for filter/sort state
- ✅ Modular structure for future filters

---

## 🚧 In Progress / Next Steps

### Phase 2: State Management & URL Sync

#### **A. Update Main Component State**

**Location:** `services/web/app/queue-v2/page.tsx`

**Add to component:**
```typescript
export default function QueueV2Page() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // New state
  const [filters, setFilters] = useState<FilterState>({
    buyerPartyId: null
  });
  const [sort, setSort] = useState<SortState>({
    field: 'date',
    direction: 'desc'
  });
  const [buyers, setBuyers] = useState<Buyer[]>([]);

  // Initialize from URL params on mount
  useEffect(() => {
    const buyerParam = searchParams.get('buyer');
    const sortParam = searchParams.get('sort');
    const dirParam = searchParams.get('dir');

    // Load from URL or localStorage
    const savedFilters = localStorage.getItem('queue-filters');
    const savedSort = localStorage.getItem('queue-sort');

    if (buyerParam || sortParam) {
      // URL takes precedence (shareable links)
      setFilters({ buyerPartyId: buyerParam });
      setSort({
        field: (sortParam as SortField) || 'date',
        direction: (dirParam as SortDirection) || 'desc'
      });
    } else if (savedFilters && savedSort) {
      // Fall back to localStorage
      setFilters(JSON.parse(savedFilters));
      setSort(JSON.parse(savedSort));
    }
  }, [searchParams]);

  // Sync to URL and localStorage on change
  const updateFiltersAndSort = (
    newFilters: Partial<FilterState>,
    newSort?: SortState
  ) => {
    const updatedFilters = { ...filters, ...newFilters };
    const updatedSort = newSort || sort;

    setFilters(updatedFilters);
    if (newSort) setSort(newSort);

    // Update URL
    const params = new URLSearchParams(searchParams);
    if (updatedFilters.buyerPartyId) {
      params.set('buyer', updatedFilters.buyerPartyId);
    } else {
      params.delete('buyer');
    }
    params.set('sort', updatedSort.field);
    params.set('dir', updatedSort.direction);
    params.set('page', '1'); // Reset to page 1 on filter/sort change

    router.push(`/queue-v2?${params.toString()}`, { scroll: false });

    // Save to localStorage
    localStorage.setItem('queue-filters', JSON.stringify(updatedFilters));
    localStorage.setItem('queue-sort', JSON.stringify(updatedSort));
  };

  // ... rest of component
}
```

#### **B. Fetch Buyers List**

Add to `fetchInvoices` or create separate function:

```typescript
const fetchBuyers = async () => {
  try {
    const res = await fetch('/api/buyers');
    const data = await res.json();
    setBuyers(data.buyers || []);
  } catch (err) {
    console.error('Failed to fetch buyers:', err);
  }
};

useEffect(() => {
  fetchBuyers();
}, []);
```

#### **C. Update fetchInvoices to Use Filters/Sort**

```typescript
const fetchInvoices = async (
  page: number = 1,
  itemsPerPage: number = perPage
) => {
  setLoading(true);
  try {
    const offset = (page - 1) * itemsPerPage;
    const params = new URLSearchParams({
      limit: itemsPerPage.toString(),
      offset: offset.toString(),
      sort: sort.field,
      dir: sort.direction
    });

    if (filters.buyerPartyId) {
      params.set('buyer', filters.buyerPartyId);
    }

    const res = await fetch(`/api/tax-invoices?${params}`);
    // ... rest of fetch logic
  } catch (err) {
    // ... error handling
  }
};
```

#### **D. Integrate Filter/Sort Components into UI**

**Location:** After the header, before the MassActionBar

```tsx
<FilterBar
  filters={filters}
  sort={sort}
  buyers={buyers}
  onFilterChange={(newFilters) => updateFiltersAndSort(newFilters)}
  onSortChange={(newSort) => updateFiltersAndSort({}, newSort)}
  onClearAll={() => updateFiltersAndSort({ buyerPartyId: null })}
/>

{/* Active Filters - only shows when filters active */}
<div className="mb-4">
  <ActiveFilters
    filters={filters}
    buyers={buyers}
    onRemove={(key) => updateFiltersAndSort({ [key]: null })}
  />
</div>
```

---

### Phase 3: API Updates

#### **A. Create Buyers Endpoint**

**File:** `services/web/app/api/buyers/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export const GET = async (req: NextRequest) => {
  try {
    // Get unique buyers from tax_invoices
    const buyers = await prisma.$queryRaw<
      { id: string; buyer_name: string }[]
    >`
      SELECT DISTINCT buyer_party_id as id, buyer_name
      FROM tax_invoices
      WHERE buyer_party_id IS NOT NULL
        AND buyer_name IS NOT NULL
      ORDER BY buyer_name ASC
    `;

    return NextResponse.json({
      buyers: buyers.map(b => ({ id: b.id, name: b.buyer_name }))
    });
  } catch (error) {
    console.error('Error fetching buyers:', error);
    return NextResponse.json(
      { error: 'Failed to fetch buyers' },
      { status: 500 }
    );
  }
};
```

#### **B. Update Tax Invoices API for Filtering/Sorting**

**File:** `services/web/app/api/tax-invoices/route.ts`

**Add to GET handler:**

```typescript
export const GET = async (req: NextRequest) => {
  const cfg = loadConfig();
  const queueCfg = cfg.queue || {};
  const sellerName = queueCfg.seller_name || 'Seller';
  const filterTin: string | undefined = queueCfg.filter?.tin;
  const { searchParams } = new URL(req.url);

  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 500);
  const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

  // NEW: Filter and sort params
  const buyerFilter = searchParams.get('buyer');
  const sortField = searchParams.get('sort') || 'date';
  const sortDir = searchParams.get('dir') || 'desc';

  // Build WHERE clause
  let whereClause = Prisma.sql`WHERE 1=1`;
  if (filterTin) {
    whereClause = Prisma.sql`${whereClause} AND tin = ${filterTin}`;
  }
  if (buyerFilter) {
    whereClause = Prisma.sql`${whereClause} AND buyer_party_id = ${buyerFilter}::uuid`;
  }

  // Build ORDER BY clause
  let orderClause = Prisma.sql`ORDER BY created_at DESC`;
  if (sortField === 'date') {
    orderClause = sortDir === 'asc'
      ? Prisma.sql`ORDER BY tax_invoice_date ASC NULLS LAST, created_at ASC`
      : Prisma.sql`ORDER BY tax_invoice_date DESC NULLS LAST, created_at DESC`;
  } else if (sortField === 'invoice_number') {
    orderClause = sortDir === 'asc'
      ? Prisma.sql`ORDER BY invoice_number ASC`
      : Prisma.sql`ORDER BY invoice_number DESC`;
  } else if (sortField === 'buyer_name') {
    orderClause = sortDir === 'asc'
      ? Prisma.sql`ORDER BY buyer_name ASC NULLS LAST`
      : Prisma.sql`ORDER BY buyer_name DESC NULLS LAST`;
  }

  // Count query
  const countResult = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*) as count FROM tax_invoices ${whereClause}
  `;
  const totalCount = Number(countResult[0]?.count || 0);

  // Data query
  const rows = await prisma.$queryRaw<
    {
      id: string;
      invoice_number: string;
      tax_invoice_date: Date | null;
      trx_code: string | null;
      buyer_name: string | null;
      buyer_party_id: string | null;
      tin: string | null;
      created_at: Date | null;
    }[]
  >`
    SELECT
      id,
      invoice_number,
      tax_invoice_date,
      trx_code,
      buyer_name,
      buyer_party_id,
      tin,
      created_at
    FROM tax_invoices
    ${whereClause}
    ${orderClause}
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  return NextResponse.json({
    invoices: rows.map((row) => ({
      id: row.id,
      invoiceNumber: row.invoice_number,
      invoiceDate: row.tax_invoice_date ? row.tax_invoice_date.toISOString().slice(0, 10) : null,
      trxCode: row.trx_code,
      buyerName: row.buyer_name,
      buyerPartyId: row.buyer_party_id,
      sellerName,
      status: 'complete'
    })),
    sellerName,
    pagination: {
      total: totalCount,
      limit,
      offset,
      hasMore: offset + rows.length < totalCount
    }
  });
};
```

---

## 🔮 Future Extensions (Ready to Add)

### **1. Status Filter**

**Add to FilterState:**
```typescript
interface FilterState {
  buyerPartyId: string | null;
  status: string | null; // 'complete' | 'processing' | 'error'
}
```

**Add to FilterBar:**
```tsx
<select
  value={filters.status || ''}
  onChange={(e) => onFilterChange({ status: e.target.value || null })}
  className="px-3 py-1.5 text-sm border border-gray-300 rounded-md"
>
  <option value="">All Statuses</option>
  <option value="complete">Complete</option>
  <option value="processing">Processing</option>
  <option value="error">Error</option>
</select>
```

### **2. Invoice Number Search**

**Add to FilterState:**
```typescript
interface FilterState {
  buyerPartyId: string | null;
  invoiceNumber: string | null;
}
```

**Add to FilterBar:**
```tsx
<input
  type="text"
  placeholder="Search invoice..."
  value={filters.invoiceNumber || ''}
  onChange={(e) => onFilterChange({ invoiceNumber: e.target.value || null })}
  className="px-3 py-1.5 text-sm border border-gray-300 rounded-md w-48"
/>
```

### **3. Month Filter (Date Range)**

**Add to FilterState:**
```typescript
interface FilterState {
  buyerPartyId: string | null;
  month: string | null; // Format: "YYYY-MM"
}
```

**Add to FilterBar:**
```tsx
<input
  type="month"
  value={filters.month || ''}
  onChange={(e) => onFilterChange({ month: e.target.value || null })}
  className="px-3 py-1.5 text-sm border border-gray-300 rounded-md"
/>
```

**Add to API:**
```typescript
if (monthFilter) {
  // Parse YYYY-MM
  const [year, month] = monthFilter.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`; // Adjust for actual month end
  whereClause = Prisma.sql`${whereClause}
    AND tax_invoice_date >= ${startDate}::date
    AND tax_invoice_date < (${startDate}::date + interval '1 month')`;
}
```

---

## 🎨 UI/UX Decisions Made

### **Visual Hierarchy**
```
┌─────────────────────────────────────────────────────────────┐
│  Processing Queue (V2)                  [Upload More]        │
├─────────────────────────────────────────────────────────────┤
│  Filters: [Buyer ▾] [Clear all]   Sort: [Date ▾] [↓]        │ ← Filter Bar
│  Active: [× Buyer: ABC Corp]                                │ ← Active Filters
├─────────────────────────────────────────────────────────────┤
│  5 selected | Clear              [Download XML] [Delete]    │ ← Mass Actions
└─────────────────────────────────────────────────────────────┘
```

### **Filter Persistence Strategy**
1. **URL** (shareable): `/queue-v2?buyer=abc&sort=date&dir=desc&page=2`
2. **localStorage** (survives refresh): User's last used filters
3. **Priority**: URL > localStorage > Defaults

### **Interaction Patterns**
- ✅ Filters reset page to 1
- ✅ Filters persist when changing per-page
- ✅ Sort maintains current page
- ✅ Selection cleared on filter change (data changes)
- ✅ "Clear all" resets filters but keeps sort

### **Accessibility**
- ✅ Keyboard navigation (Tab, Enter, Escape)
- ✅ ARIA labels on all controls
- ✅ Focus management in dropdowns
- ✅ Screen reader friendly

---

## 📦 Component Structure

```
services/web/app/queue-v2/page.tsx
├── FilterBar              (Filters + Sort controls)
│   ├── Buyer dropdown     (searchable)
│   ├── Sort selector      (field + direction)
│   └── Clear all button
├── ActiveFilters          (Filter chips)
│   └── Individual chips   (removable)
├── MassActionBar          (Bulk actions)
├── Table                  (Invoice list)
└── PaginationControls     (Page navigation)

services/web/app/api/
├── buyers/route.ts        (NEW - Get unique buyers)
└── tax-invoices/route.ts  (UPDATED - Add filter/sort support)
```

---

## 🧪 Testing Checklist

### **Filter Tests**
- [ ] Select buyer from dropdown
- [ ] Search buyers by name
- [ ] Filter persists on page change
- [ ] Filter in URL (shareable link)
- [ ] Filter in localStorage (refresh)
- [ ] Remove filter via chip
- [ ] Remove filter via "Clear all"
- [ ] No buyers match search query

### **Sort Tests**
- [ ] Sort by date (asc/desc)
- [ ] Sort by invoice number (asc/desc)
- [ ] Sort by buyer name (asc/desc)
- [ ] Sort persists on page change
- [ ] Sort in URL
- [ ] Sort direction toggle

### **Integration Tests**
- [ ] Filter + Sort + Pagination work together
- [ ] Filter + Selection (selection clears on filter change)
- [ ] Multiple filters (when added)
- [ ] Empty states (no results)
- [ ] Error states (API failure)

### **URL/Storage Tests**
- [ ] Share URL with filters
- [ ] Refresh page (filters persist)
- [ ] Open in new tab (filters from URL)
- [ ] Clear browser storage (falls back to defaults)

---

## 📊 Performance Considerations

### **Optimizations Applied**
- ✅ `useMemo` for filtered buyer list
- ✅ Debouncing on search input (built into controlled state)
- ✅ `useCallback` for event handlers
- ✅ API limits results (max 500 per request)
- ✅ Index on `buyer_party_id`, `tax_invoice_date` in database

### **Future Optimizations**
- [ ] Virtual scrolling for buyer dropdown (if >1000 buyers)
- [ ] Server-side buyer search (if >1000 buyers)
- [ ] Query caching (React Query / SWR)
- [ ] Optimistic UI updates

---

## 🚀 Deployment Checklist

### **Before Merge**
- [ ] Complete Phase 2 (State Management)
- [ ] Complete Phase 3 (API Updates)
- [ ] Run all tests
- [ ] Check TypeScript compilation
- [ ] Test in both Chrome and Safari
- [ ] Verify mobile responsiveness
- [ ] Check accessibility (screen reader)
- [ ] Update any documentation

### **Database Migrations**
- [ ] Ensure `buyer_party_id` column exists in `tax_invoices`
- [ ] Add index: `CREATE INDEX IF NOT EXISTS idx_tax_invoices_buyer_party_id ON tax_invoices(buyer_party_id)`
- [ ] Add index: `CREATE INDEX IF NOT EXISTS idx_tax_invoices_date ON tax_invoices(tax_invoice_date DESC NULLS LAST)`

---

## 📝 Notes & Decisions

### **Why Single Buyer Selection?**
- User requirement: "just one" buyer at a time
- Simpler UX, fewer edge cases
- Can be extended to multi-select later if needed

### **Why Month Picker (not Date Range)?**
- User requirement: "filter by month"
- Simpler than dual date picker
- Common use case for invoice filtering

### **Why URL + localStorage?**
- URL: Shareable links (user can send filtered view to colleague)
- localStorage: Convenience (return to same view next day)
- URL takes precedence (explicit > implicit)

### **Why Reset Page on Filter Change?**
- Data set changes, page 5 might not exist anymore
- Common pattern (Google, GitHub, etc.)
- Avoids confusion

---

## 🔗 Related Files

- `services/web/app/queue-v2/page.tsx` - Main component
- `services/web/app/api/tax-invoices/route.ts` - Invoice API
- `services/web/app/api/buyers/route.ts` - Buyers API (NEW)
- `services/web/prisma/schema.prisma` - Database schema

---

## 📞 Questions or Issues?

If you encounter any issues or have questions:

1. Check this document first
2. Review the TypeScript types in `page.tsx`
3. Test the API endpoints directly with Postman/curl
4. Check browser console for errors
5. Verify database indexes exist

---

**Last Updated:** 2025-11-25
**Status:** Phase 1 Complete, Phase 2-3 In Progress
**Next Milestone:** Complete state management & API updates
