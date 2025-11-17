## Phase 1 Development Plan: Schema & Queue Enhancement

### Prerequisites
- Docker environment running with PostgreSQL
- Access to both `services/web` and `services/worker` Prisma schemas
- Sample data from `services/pdf2json/results/simon/11-final.json`

---

## Step 1: Database Schema Extensions

### 1.1 Create Migration Files for New Tables

**Location:** `services/web/prisma/schema.prisma` and `services/worker/prisma/schema.prisma`

Add these models to both schemas:

```prisma
model Vendor {
  id              String    @id @default(uuid())
  name            String    @unique
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")
  
  productInfo     ProductInformation[]
  
  @@map("vendors")
}

model Uom {
  code            String    @id // e.g., "UM.0021"
  name            String    // e.g., "Piece"
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")
  
  productInfo     ProductInformation[]
  
  @@map("uom_codes")
}

model ProductInformation {
  id              String    @id @default(uuid())
  vendorId        String    @map("vendor_id")
  sku             String?
  description     String    @db.Text
  uomCode         String    @map("uom_code")
  optCode         String    @map("opt_code")
  hsCode          String    @map("hs_code")
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")
  
  vendor          Vendor    @relation(fields: [vendorId], references: [id])
  uom             Uom       @relation(fields: [uomCode], references: [code])
  
  @@unique([vendorId, sku])
  @@unique([vendorId, description])
  @@index([vendorId])
  @@map("product_information")
}
```

### 1.2 Update Job Model

Add to the existing `Job` model in both schemas:

```prisma
approved        Boolean   @default(false)
approvedAt      DateTime? @map("approved_at")
```

### 1.3 Generate and Run Migrations

```bash
# In services/web directory
npx prisma migrate dev --name add_product_information_tables

# In services/worker directory  
npx prisma migrate dev --name add_product_information_tables
```

---

## Step 2: Seed Data Preparation

### 2.1 Create UOM Seed Script

**Location:** `services/web/prisma/seed-uom.ts`

Parse the UOM.csv file and insert records:
- Read CSV with code/name pairs
- Use Prisma client to upsert records
- Handle duplicates gracefully

### 2.2 Create Vendor Seed Script

**Location:** `services/web/prisma/seed-vendors.ts`

Extract vendor from sample data:
- Read `services/pdf2json/results/simon/11-final.json`
- Extract `seller.name` field
- Create vendor with case-insensitive duplicate check

### 2.3 Run Seed Scripts

```bash
npx tsx prisma/seed-uom.ts
npx tsx prisma/seed-vendors.ts
```

---

## Step 3: Update Queue API

### 3.1 Modify Jobs API Endpoint

**Location:** `services/web/app/api/jobs/route.ts`

Update the job selector to include the `approved` field:

```typescript
const jobs = await prisma.job.findMany({
  where: { ownerSessionId: sessionId },
  select: {
    // ... existing fields
    approved: true,
    approvedAt: true,
  },
  // ... rest of query
});
```

---

## Step 4: Update Queue UI Components

### 4.1 Update Job Type Definition

**Location:** `services/web/app/queue/page.tsx`

Add to Job interface:
```typescript
interface Job {
  // ... existing fields
  approved: boolean;
  approvedAt: string | null;
}
```

### 4.2 Add Approved Column to Grid

**Location:** `services/web/app/queue/components/QueueDataGrid.tsx`

Update grid columns configuration:
- Add "Approved" column header
- Display "Yes"/"No" based on job.approved value
- Use existing StatusChip component pattern for consistency

### 4.3 Update Grid Row Component

**Location:** `services/web/app/queue/components/QueueGridRow.tsx`

Add approved status display:
- New cell showing "Yes" or "No"
- Style consistently with existing status chips
- Position after Status column, before Actions

---

## Step 5: Sample Data Insertion

### 5.1 Create Product Information Seed

**Location:** `services/web/prisma/seed-products.ts`

Using items from `services/pdf2json/results/simon/11-final.json`:
1. Parse the JSON file
2. Extract vendor from seller.name
3. For each item, create productInformation records with:
   - vendorId (lookup from vendors table)
   - sku, description from items
   - Map UOM values to UOM codes
   - Use appropriate hsCode from items

---

## Step 6: Testing & Verification

### 6.1 Database Verification
```sql
-- Check tables exist
SELECT * FROM vendors;
SELECT * FROM uom_codes LIMIT 10;
SELECT * FROM product_information LIMIT 10;

-- Check job approved field
SELECT id, original_filename, approved, approved_at 
FROM jobs LIMIT 10;
```

### 6.2 UI Testing
1. Start development environment: `docker-compose -f docker-compose.yaml -f docker-compose.development.yml up`
2. Navigate to Queue page (http://localhost:3000/queue)
3. Verify "Approved" column appears
4. Manually update a job's approved status in DB
5. Verify UI reflects the change

### 6.3 Download Functionality Test
1. Test XML download for approved=false jobs
2. Test XML download for approved=true jobs
3. Verify downloads work exactly as before
4. Test bulk download functionality

---

## Step 7: Error Handling & Edge Cases

### 7.1 Handle NULL SKUs
- Ensure unique constraint allows multiple NULL skus
- Test lookup precedence (SKU first, then description)

### 7.2 Case-Insensitive Vendor Matching
- Implement case-insensitive search in vendor lookup
- Test with variations of vendor names

### 7.3 Migration Rollback Plan
- Keep migration scripts reversible
- Document rollback procedure

---

## Integration Points & Dependencies

1. **Prisma Schema Sync**: Both web and worker services need identical schema updates
2. **Type Generation**: Run `npx prisma generate` after schema changes
3. **Docker Volumes**: Ensure PostgreSQL data persists across container restarts
4. **Environment Variables**: No new env vars needed for Phase 1
5. **Existing Endpoints**: `/api/jobs/[id]/download` and bulk download must remain unchanged

---

## Acceptance Criteria Checklist

- [ ] productInformation table created and accessible
- [ ] vendors table created with sample vendor
- [ ] uom_codes table created and seeded from CSV
- [ ] Jobs table has approved field (default false)
- [ ] Queue UI shows Approved column
- [ ] Approved column shows Yes/No correctly
- [ ] XML downloads work unchanged
- [ ] Artifact downloads work unchanged
- [ ] Sample product information records exist
- [ ] No breaking changes to existing functionality

This plan provides a foundation for Phase 2's review interface while keeping Phase 1 focused and testable.