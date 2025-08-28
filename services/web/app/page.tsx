import { PDFDropzone } from '@/components/dropzone/PDFDropzone'

export default function Home() {
  return (
    <>
      {/* Hero Section */}
      <section className="hero-section">
        <div className="container">
          <h1 className="hero-title">
            Transform Your PDFs with Ease
          </h1>
          <p className="hero-subtitle">
            Upload, process, and convert your PDF documents with our powerful drag-and-drop interface. 
            Fast, secure, and reliable processing in the cloud.
          </p>
        </div>
      </section>

      {/* Main Content */}
      <main className="main-content">
        <div className="container">
          <section className="dropzone-section">
            <PDFDropzone />
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer style={{ 
        textAlign: 'center', 
        padding: '40px 20px', 
        color: '#6b7280',
        borderTop: '1px solid #e5e7eb',
        marginTop: '80px'
      }}>
        <p>PDF Processing Gateway - Secure document processing at scale</p>
      </footer>
    </>
  )
}