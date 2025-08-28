import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'PDF Processing Gateway - Upload & Transform',
  description: 'Modern drag-and-drop interface for PDF processing and transformation services',
  keywords: 'PDF, upload, processing, drag and drop, file conversion',
  authors: [{ name: 'PDF Processing Gateway' }],
  viewport: 'width=device-width, initial-scale=1',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <meta name="theme-color" content="#3b82f6" />
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body>
        <div id="root">
          {children}
        </div>
      </body>
    </html>
  )
}