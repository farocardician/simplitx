Optimal Template Dropdown Implementation

     Files to Modify (4 files total)

     1. services/pdf2json/main.py (ADD endpoint)
     @app.get("/templates")
     async def get_templates():
         """Get available processing templates"""
         # Read all JSON files from config/ directory
         # Return [{name, version, filename}] array

     2. services/gateway/main.py (ADD route)
     @app.get("/pdf2json/templates")
     async def proxy_templates():
         # Forward to pdf2json service /templates endpoint

     3. services/web/components/dropzone/PDFDropzone.tsx (MODIFY)
     - Add template state: const [selectedTemplate, setSelectedTemplate] = useState('')
     - Add useEffect to fetch templates from /api/gateway/pdf2json/templates 
     - Add simple <select> dropdown above dropzone
     - Pass selectedTemplate to upload hook

     4. services/web/components/dropzone/PDFDropzone.module.css (MODIFY)
     - Add .templateSelector styles for dropdown
     - Maintain minimal, modern design consistent with dropzone

     Key Benefits

     ✅ Simple: Only 4 file changes, minimal code
     ✅ Scalable: Adding new config files auto-appears in dropdown✅ Best Practice: Follows existing microservices routing pattern
     ✅ Minimal Change: Uses existing Gateway proxy pattern
     ✅ Dynamic: Config file changes reflect immediately
