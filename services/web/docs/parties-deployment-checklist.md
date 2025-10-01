# Party Management System - Deployment Checklist

## Overview
This document provides pre-deployment validation queries and post-deployment verification steps for the Party Management system.

## Pre-Deployment Validation

### 1. Check for Normalization Issues

```sql
-- Find records where normalized fields don't match expected values
SELECT
  id,
  display_name,
  name_normalized,
  normalize_party_name(display_name) as should_be_name,
  tin_display,
  tin_normalized,
  normalize_tin(tin_display) as should_be_tin
FROM parties
WHERE
  name_normalized != normalize_party_name(display_name)
  OR tin_normalized != normalize_tin(tin_display);
```

**Expected Result:** 0 rows
**If rows found:** Run normalization fix (see section 4)

---

### 2. Find Name Collisions (Same Name, Different TIN)

```sql
-- Find parties with same normalized name but different TINs
SELECT
  name_normalized,
  COUNT(*) as count,
  ARRAY_AGG(display_name) as names,
  ARRAY_AGG(tin_normalized) as tins,
  ARRAY_AGG(id::text) as ids
FROM parties
WHERE deleted_at IS NULL
GROUP BY name_normalized
HAVING COUNT(*) > 1;
```

**Expected Result:** 0 rows
**If rows found:** Manual resolution required (see section 5)

---

### 3. Find TIN Duplicates Within Same Country

```sql
-- Find parties with same TIN in same country
SELECT
  country_code,
  tin_normalized,
  COUNT(*) as count,
  ARRAY_AGG(display_name) as names,
  ARRAY_AGG(id::text) as ids
FROM parties
WHERE deleted_at IS NULL
  AND country_code IS NOT NULL
GROUP BY country_code, tin_normalized
HAVING COUNT(*) > 1;
```

**Expected Result:** 0 rows
**If rows found:** Manual resolution required (see section 5)

---

### 4. Fix Normalization (If Needed)

```sql
-- Update all records to ensure normalization matches
UPDATE parties
SET
  name_normalized = normalize_party_name(display_name),
  tin_normalized = normalize_tin(tin_display),
  updated_at = NOW()
WHERE
  name_normalized != normalize_party_name(display_name)
  OR tin_normalized != normalize_tin(tin_display);
```

**Note:** This should only be needed if triggers weren't active during initial data import.

---

## 5. Manual Collision Resolution Process

### For Name Collisions:

1. **Export collision report:**
```sql
\copy (
  SELECT
    name_normalized,
    display_name,
    tin_display,
    tin_normalized,
    country_code,
    email,
    address_full,
    created_at,
    id
  FROM parties
  WHERE name_normalized IN (
    SELECT name_normalized
    FROM parties
    WHERE deleted_at IS NULL
    GROUP BY name_normalized
    HAVING COUNT(*) > 1
  )
  AND deleted_at IS NULL
  ORDER BY name_normalized, created_at
) TO '/tmp/party_name_collisions.csv' WITH CSV HEADER;
```

2. **Review with business team** to determine:
   - Are these actually the same company? → Merge (keep one, soft-delete others)
   - Are these different companies? → Rename one to distinguish (e.g., "ABC Corporation USA" vs "ABC Corporation Brasil")

3. **Merge duplicates** (example):
```sql
-- Keep the oldest record, soft-delete the duplicate
UPDATE parties
SET deleted_at = NOW()
WHERE id = '<duplicate-party-id>';
```

4. **Rename to distinguish** (example):
```sql
-- Add distinguishing suffix to name
UPDATE parties
SET
  display_name = display_name || ' (Region/Suffix)',
  updated_at = NOW()
WHERE id = '<party-to-rename-id>';
```

### For TIN Collisions:

1. **Export collision report:**
```sql
\copy (
  SELECT
    country_code,
    tin_normalized,
    tin_display,
    display_name,
    email,
    created_at,
    id
  FROM parties
  WHERE (country_code, tin_normalized) IN (
    SELECT country_code, tin_normalized
    FROM parties
    WHERE deleted_at IS NULL AND country_code IS NOT NULL
    GROUP BY country_code, tin_normalized
    HAVING COUNT(*) > 1
  )
  AND deleted_at IS NULL
  ORDER BY country_code, tin_normalized, created_at
) TO '/tmp/party_tin_collisions.csv' WITH CSV HEADER;
```

2. **Review with business team** - This usually indicates:
   - Data entry error (wrong TIN on one record) → Fix the TIN
   - Duplicate records → Merge (soft-delete one)

3. **Fix TIN** (example):
```sql
UPDATE parties
SET
  tin_display = '<correct-tin>',
  updated_at = NOW()
WHERE id = '<party-with-wrong-tin>';
```

---

## Post-Deployment Verification

### 1. Verify Unique Indexes Are Active

```sql
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'parties'
  AND indexname LIKE '%active%'
ORDER BY indexname;
```

**Expected Result:** 3 unique indexes:
- `idx_parties_name_normalized_active`
- `idx_parties_tin_normalized_with_country`
- `idx_parties_tin_normalized_no_country`

---

### 2. Verify Triggers Are Active

```sql
SELECT
  tgname AS trigger_name,
  tgtype,
  tgenabled
FROM pg_trigger
WHERE tgrelid = 'parties'::regclass
  AND tgname NOT LIKE 'pg_%'
ORDER BY tgname;
```

**Expected Result:** 4 triggers:
- `trg_auto_normalize_party_fields`
- `trg_check_name_tin_collision`
- `trg_parties_updated_at`
- `trg_validate_country_code_update`

All should show `tgenabled = 'O'` (origin enabled)

---

### 3. Test Data Validation

```sql
-- Test 1: Create party with valid data (should succeed)
INSERT INTO parties (display_name, tin_display, country_code)
VALUES ('Test Company', '12-345-678', 'USA')
RETURNING id, display_name, name_normalized, tin_normalized;

-- Test 2: Try to create duplicate name (should fail with collision error)
INSERT INTO parties (display_name, tin_display, country_code)
VALUES ('Test Company', '99-999-999', 'USA')
RETURNING id;
-- Expected: ERROR: Name collision: "Test Company" already exists with different TIN

-- Test 3: Try to create duplicate TIN in same country (should fail with unique constraint)
INSERT INTO parties (display_name, tin_display, country_code)
VALUES ('Another Company', '12-345-678', 'USA')
RETURNING id;
-- Expected: ERROR: duplicate key value violates unique constraint

-- Clean up test data
DELETE FROM parties WHERE display_name = 'Test Company';
```

---

### 4. Verify API Endpoints

```bash
# Test GET with pagination
curl -s "http://localhost:3000/api/parties?page=1&limit=10" | jq '.pagination'

# Test search
curl -s "http://localhost:3000/api/parties?search=ABC" | jq '.parties | length'

# Test country filter
curl -s "http://localhost:3000/api/parties?country_code=USA" | jq '.parties | length'

# Test POST (create party)
curl -X POST http://localhost:3000/api/parties \
  -H "Content-Type: application/json" \
  -d '{"displayName":"API Test Company","tinDisplay":"11-111-111","countryCode":"USA"}' \
  | jq '.id'

# Get the party for PUT test
PARTY_ID=$(curl -s "http://localhost:3000/api/parties?search=API%20Test" | jq -r '.parties[0].id')
UPDATED_AT=$(curl -s "http://localhost:3000/api/parties?search=API%20Test" | jq -r '.parties[0].updatedAt')

# Test PUT (update party)
curl -X PUT "http://localhost:3000/api/parties/$PARTY_ID" \
  -H "Content-Type: application/json" \
  -d "{\"displayName\":\"API Test Company Updated\",\"tinDisplay\":\"11-111-111\",\"countryCode\":\"USA\",\"updatedAt\":\"$UPDATED_AT\"}" \
  | jq '.displayName'

# Test DELETE (soft delete)
curl -X DELETE "http://localhost:3000/api/parties/$PARTY_ID" | jq '.success'

# Test PATCH (restore)
curl -X PATCH "http://localhost:3000/api/parties/$PARTY_ID" \
  -H "Content-Type: application/json" \
  -d '{"action":"restore"}' \
  | jq '.success'

# Final cleanup
curl -X DELETE "http://localhost:3000/api/parties/$PARTY_ID"
```

---

### 5. Verify UI Functionality

1. **Navigate to** `http://localhost:3000/admin/parties`

2. **Test Add Party:**
   - Click "+ Add Party"
   - Fill in company name and TIN
   - Press Enter
   - Verify success toast

3. **Test Inline Edit:**
   - Click on any cell (email, address, etc.)
   - Modify value
   - Press Enter
   - Verify update

4. **Test Search:**
   - Type in search box
   - Verify results update (300ms debounce)
   - Try searching by name and TIN

5. **Test Delete with Undo:**
   - Click "Delete" on a party
   - Verify toast shows "Undo" button
   - Click "Undo" within 5 seconds
   - Verify party restored

6. **Test Race Condition:**
   - Open same party in two browser tabs
   - Edit field in tab 1, save
   - Edit same party in tab 2, try to save
   - Verify conflict error message appears

7. **Test Collision Detection:**
   - Try to create party with existing name but different TIN
   - Verify error shows existing party details
   - Try to create party with existing TIN in same country
   - Verify error shows existing party details

---

## Configuration Constants

Document these thresholds in your codebase:

```typescript
// In /app/api/parties/route.ts
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

// In /app/admin/parties/page.tsx
const CLIENT_SIDE_THRESHOLD = 200;
```

**CLIENT_SIDE_THRESHOLD:** When total party count exceeds this, consider client-side filtering. For server-side, pagination handles the load automatically.

---

## Rollback Plan

If issues are discovered after deployment:

1. **Disable the UI:**
```typescript
// In /app/admin/parties/page.tsx
// Add at top of component:
if (process.env.NODE_ENV === 'production') {
  return <div>Party management is temporarily disabled</div>;
}
```

2. **Revert API endpoints** (if needed):
```bash
git revert <commit-hash>
```

3. **Database rollback** (if schema was changed):
```sql
-- Drop triggers
DROP TRIGGER IF EXISTS trg_auto_normalize_party_fields ON parties;
DROP TRIGGER IF EXISTS trg_check_name_tin_collision ON parties;
DROP TRIGGER IF EXISTS trg_validate_country_code_update ON parties;
DROP TRIGGER IF EXISTS trg_parties_updated_at ON parties;

-- Drop indexes
DROP INDEX IF EXISTS idx_parties_name_normalized_active;
DROP INDEX IF EXISTS idx_parties_tin_normalized_with_country;
DROP INDEX IF EXISTS idx_parties_tin_normalized_no_country;

-- Note: Keep table and data for investigation
```

---

## Success Criteria

✅ All pre-deployment validation queries return 0 rows (no collisions)
✅ All 4 database triggers are enabled
✅ All 3 unique indexes are active
✅ All API endpoint tests pass
✅ UI loads without errors
✅ Add, edit, delete, search, filter all work
✅ Race condition detection works
✅ Collision detection works
✅ 5-second undo works

---

## Support

For issues during deployment:
1. Check Docker logs: `docker logs simplitx-web-1 --tail 100`
2. Check PostgreSQL logs: `docker logs simplitx-postgres-1 --tail 100`
3. Run validation queries to identify data issues
4. Consult this checklist for resolution steps
