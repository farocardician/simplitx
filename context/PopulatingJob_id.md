# Implementation Plan: Populating job_id in parser_results Table (MVP)

## 📋 Overview

The current system processes PDF invoices through a pipeline where:
- **processor.js** manages jobs and calls the gateway service
- **s10_parser.py** (Stage 10) saves parsed results to the database
- The `parser_results` table has a `job_id` column that isn't being populated

**Goal:** Connect the job ID from the job processing context to the parser results in the database.

**MVP Approach:** Pass job_id through the pipeline using environment variables.

---

## 🎯 Implementation Strategy

### Single Approach: Pass job_id Through Pipeline via Environment Variable

**Why Environment Variable?**
- Minimal code changes required
- No need to modify all intermediate stages' command-line interfaces
- Gateway can easily set it for all child processes

---

## 📝 Phase 1: Core Implementation

### **Step 1: Database Migration**

**What to do:**
- Add nullable `job_id` column to `parser_results` table
- Create basic index for query performance
- Skip foreign key for MVP (reduces deployment complexity)

**Migration SQL:**
```sql
-- Add job_id column (nullable for backward compatibility)
ALTER TABLE parser_results 
ADD COLUMN IF NOT EXISTS job_id TEXT;

-- Create index for query performance
CREATE INDEX IF NOT EXISTS idx_parser_results_job_id 
ON parser_results(job_id);

-- Note: No FK constraint in MVP to keep it simple
```

---

### **Step 2: Modify processor.js**

**What to do:**
- Pass job_id to the gateway as form data
- Gateway will set it as environment variable for all stages

**Code changes in processor.js:**
```javascript
async function callGateway(pdfPath, template, jobId) {  // Add jobId parameter
  const form = new FormData();
  form.append('file', createReadStream(pdfPath), {
    filename: 'document.pdf',
    contentType: 'application/pdf'
  });
  
  // Pass job_id to gateway
  form.append('job_id', jobId);
  
  if (template) {
    form.append('template', template);
  }
  form.append('mapping', `pt_simon_invoice_v1.json`);
  form.append('pretty', '1');
  
  // ... rest of the function remains the same
}

async function processJob(job) {
  logger.info(`Processing job ${job.id}`);
  
  try {
    const pdfPath = job.upload_path;
    if (!pdfPath) {
      throw new Error('No upload path specified');
    }
    
    // Pass job.id to gateway
    const xmlContent = await callGateway(pdfPath, job.mapping, job.id);
    
    // ... rest of the function remains the same
  } catch (error) {
    await handleJobError(job, error);
  }
}

// Also update fetchArtifacts if needed
async function fetchArtifacts(pdfPath, template, jobId) {
  const form = new FormData();
  form.append('file', createReadStream(pdfPath), {
    filename: 'document.pdf',
    contentType: 'application/pdf'
  });
  form.append('job_id', jobId);  // Add job_id here too
  
  // ... rest of the function
}
```

---

### **Step 3: Gateway Service Changes**

**What to do:**
- Gateway accepts `job_id` from the form data
- Sets `JOB_ID` environment variable when executing pipeline stages

**Pseudo-code for gateway:**
```python
# In gateway service (conceptual)
def process_request(request):
    job_id = request.form.get('job_id')
    
    # Set environment variable for all child processes
    env = os.environ.copy()
    if job_id:
        env['JOB_ID'] = job_id
    
    # Execute pipeline stages with this environment
    subprocess.run(stage_command, env=env)
```

---

### **Step 4: Modify s10_parser.py**

**What to do:**
- Read `JOB_ID` from environment variable
- Pass it to the database persistence function

**Code changes in s10_parser.py:**
```python
def persist_to_database(doc_id: str, final_doc: Dict[str, Any], 
                        manifest: Dict[str, Any], job_id: str = None) -> None:
    """Persist the parser output to Postgres with optional job_id."""
    if not doc_id:
        return

    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        return

    try:
        import psycopg
        from psycopg.types.json import Json
    except ImportError:
        print("[s10_parser] psycopg not installed; skipping database persistence", 
              file=sys.stderr)
        return

    try:
        with psycopg.connect(database_url, autocommit=True) as conn:
            with conn.cursor() as cur:
                # Ensure table has job_id column
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS parser_results (
                        doc_id TEXT PRIMARY KEY,
                        job_id TEXT,
                        final JSONB NOT NULL,
                        manifest JSONB NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                
                # Insert with job_id (can be None for backward compatibility)
                cur.execute(
                    """
                    INSERT INTO parser_results (doc_id, job_id, final, manifest)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (doc_id) DO UPDATE
                    SET job_id = EXCLUDED.job_id,
                        final = EXCLUDED.final,
                        manifest = EXCLUDED.manifest,
                        updated_at = NOW()
                    """,
                    (doc_id, job_id, Json(final_doc), Json(manifest))
                )
                
                if job_id:
                    print(f"[s10_parser] Saved results for doc_id={doc_id}, job_id={job_id}")
                
    except Exception as exc:
        print(f"[s10_parser] failed to persist results for doc_id={doc_id}: {exc}", 
              file=sys.stderr)


def main():
    # ... existing argument parsing code ...
    
    # Get job_id from environment variable
    job_id = os.getenv('JOB_ID')
    
    # ... existing processing code ...
    
    # Pass job_id to persist_to_database
    persist_to_database(
        final.get("doc_id"), 
        final, 
        manifest,
        job_id=job_id  # Will be None if not set
    )
    
    # Include job_id in output for logging
    output = {
        "stage": "final",
        "doc_id": final["doc_id"],
        "job_id": job_id,  # Add this
        "items": len(items_out),
        "subtotal": totals["subtotal"],
        "grand_total": totals["grand_total"],
        "confidence": confidence.get("score"),
        "issues": issues,
        "final": str(final_p),
        "manifest": str(manifest_p),
        "config": str(config_p)
    }
    print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
```

---

## 🧪 Testing Plan

### 1. **Local Testing**
```bash
# Test s10_parser.py with JOB_ID env var
export JOB_ID="test-job-123"
python s10_parser.py --fields ... --items ... # other required args

# Verify in database
psql $DATABASE_URL -c "SELECT job_id, doc_id FROM parser_results WHERE job_id = 'test-job-123'"
```

### 2. **Integration Testing**
```javascript
// Test that processor.js sends job_id
it('should include job_id in gateway request', async () => {
  const job = { id: 'test-456', mapping: 'template1', upload_path: '/path/to/pdf' };
  // Mock axios and verify form data includes job_id
});
```

### 3. **End-to-End Verification**
1. Upload a PDF (creates job)
2. Process through pipeline
3. Query: `SELECT * FROM parser_results WHERE job_id = ?`
4. Verify job_id is populated

---

## 🚀 Deployment Steps

### **Deploy Order (Zero-Downtime)**

1. **Database Migration**
   ```bash
   psql $DATABASE_URL < migration.sql
   ```

2. **Deploy s10_parser.py**
   - Deploy updated version that reads `JOB_ID` env var
   - Still works without it (backward compatible)

3. **Deploy Gateway Updates**
   - Update to accept and propagate job_id
   - Set `JOB_ID` environment variable

4. **Deploy processor.js**
   - Update to send job_id to gateway
   - Monitor logs for confirmation

## 🔍 Verification Checklist

### Phase 1 Complete When:
- [ ] Migration adds job_id column with index
- [ ] s10_parser.py reads JOB_ID from environment
- [ ] processor.js sends job_id to gateway
- [ ] Gateway sets JOB_ID environment variable
- [ ] New jobs have job_id populated in parser_results
- [ ] Existing functionality still works (backward compatible)
