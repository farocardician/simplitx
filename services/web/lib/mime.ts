/**
 * PDF MIME types and extensions validation
 */

export const PDF_MIME_TYPES = [
  'application/pdf',
  'application/x-pdf',
  'application/acrobat',
  'applications/vnd.pdf',
  'text/pdf',
  'text/x-pdf'
] as const

export const PDF_EXTENSIONS = ['.pdf'] as const

/**
 * Check if file is a valid PDF by MIME type
 */
export function isValidPDFMime(file: File): boolean {
  return PDF_MIME_TYPES.includes(file.type as any)
}

/**
 * Check if filename has PDF extension
 */
export function isValidPDFExtension(filename: string): boolean {
  const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'))
  return PDF_EXTENSIONS.includes(ext as any)
}

/**
 * Comprehensive PDF validation (MIME + extension)
 */
export function isValidPDF(file: File): boolean {
  const hasValidMime = isValidPDFMime(file)
  const hasValidExt = isValidPDFExtension(file.name)
  
  // Both checks must pass for maximum security
  return hasValidMime && hasValidExt
}

/**
 * Get validation error message for non-PDF files
 */
export function getPDFValidationError(file: File): string {
  const hasValidMime = isValidPDFMime(file)
  const hasValidExt = isValidPDFExtension(file.name)
  
  if (!hasValidExt && !hasValidMime) {
    return `"${file.name}" is not a PDF file. Only PDF files are allowed.`
  } else if (!hasValidExt) {
    return `"${file.name}" doesn't have a PDF extension. Please ensure the file ends with .pdf`
  } else if (!hasValidMime) {
    return `"${file.name}" appears to be mislabeled. The file content doesn't match PDF format.`
  }
  
  return ''
}