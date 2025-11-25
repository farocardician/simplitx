'use client'

import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { useUpload } from '@/hooks/useUpload'
import { FileItem } from './FileItem'
import styles from './PDFDropzone.module.css'

interface Template {
  name: string
  version: string
  filename: string
  display_name: string
  enabled?: boolean  // Optional - backend already filters disabled configs
  ingestion_type?: 'pdf' | 'xls'
  queue_page?: string
  upload?: {
    accept?: string[]
    endpoint?: string
    max_size_mb?: number
  }
}

export function PDFDropzone() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragActive, setIsDragActive] = useState(false)
  const [dragError, setDragError] = useState(false)
  const [templates, setTemplates] = useState<Template[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<string>('')
  const [templatesLoading, setTemplatesLoading] = useState(true)
  
  const selectedTemplateMeta = useMemo(() => {
    const tpl = templates.find(t => t.filename === selectedTemplate)
    const ingestionType = tpl?.ingestion_type || 'pdf'
    const acceptExtensions = (tpl?.upload?.accept && tpl.upload.accept.length > 0)
      ? tpl.upload.accept
      : (ingestionType === 'xls' ? ['.xls', '.xlsx'] : ['.pdf'])
    const queuePage = tpl?.queue_page || '/queue'
    const uploadEndpoint = tpl?.upload?.endpoint || '/api/upload'
    const maxSizeMb = tpl?.upload?.max_size_mb || 100

    return {
      ingestionType,
      acceptExtensions,
      queuePage,
      uploadEndpoint,
      maxSizeMb
    }
  }, [templates, selectedTemplate])

  const {
    files,
    isUploading,
    error,
    redirectCountdown,
    addFiles,
    removeFile,
    cancelUpload,
    startUploads,
    clearError,
    reset,
    canUpload
  } = useUpload({ 
    getTemplate: () => selectedTemplate,
    getTemplateMeta: () => selectedTemplateMeta
  })

  // Fetch available templates on component mount
  useEffect(() => {
    const fetchTemplates = async () => {
      try {
        const response = await fetch('/api/gateway/pdf2json/templates')
        if (response.ok) {
          const data = await response.json()
          setTemplates(data.templates || [])
          // Set first template as default if available
          if (data.templates && data.templates.length > 0) {
            const defaultTemplate = data.templates.find((tpl: Template) => (tpl.ingestion_type || 'pdf') === 'pdf') || data.templates[0]
            setSelectedTemplate(defaultTemplate.filename)
          }
        }
      } catch (error) {
        console.error('Failed to fetch templates:', error)
      } finally {
        setTemplatesLoading(false)
      }
    }

    fetchTemplates()
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragActive(true)
    setDragError(false)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    
    // Only deactivate if we're leaving the dropzone container
    if (e.currentTarget.contains(e.relatedTarget as Node)) {
      return
    }
    
    setIsDragActive(false)
    setDragError(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const expected = selectedTemplateMeta.ingestionType
    const hasInvalidFiles = Array.from(e.dataTransfer.items).some(item => {
      if (item.kind !== 'file') return false
      const type = item.type || ''
      if (!type) return false
      if (expected === 'xls') {
        return !type.includes('sheet') && !type.includes('excel')
      }
      return !type.includes('pdf')
    })
    setDragError(hasInvalidFiles)
  }, [selectedTemplateMeta])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    
    setIsDragActive(false)
    setDragError(false)
    
    const droppedFiles = Array.from(e.dataTransfer.files)
    if (droppedFiles.length > 0) {
      addFiles(droppedFiles)
    }
  }, [addFiles])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files
    if (selectedFiles && selectedFiles.length > 0) {
      addFiles(Array.from(selectedFiles))
    }
    
    // Reset input so same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [addFiles])

  const handleClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleClick()
    }
  }, [handleClick])

  const getDropzoneClassName = () => {
    let className = styles.dropzone
    if (isDragActive && !dragError) className += ` ${styles.dropzoneActive}`
    if (dragError) className += ` ${styles.dropzoneError}`
    return className
  }

  return (
    <div className="pdf-dropzone-container">
      {/* Template Selector */}
      <div className={styles.templateSelector}>
        <label htmlFor="template-select" className={styles.templateLabel}>
          Processing Template
        </label>
        <select
          id="template-select"
          value={selectedTemplate}
          onChange={(e) => setSelectedTemplate(e.target.value)}
          className={styles.templateDropdown}
          disabled={templatesLoading}
        >
          {templatesLoading ? (
            <option value="">Loading templates...</option>
          ) : templates.length === 0 ? (
            <option value="">No templates available</option>
          ) : (
            templates.map((template) => (
              <option key={template.filename} value={template.filename}>
                {template.display_name}
              </option>
            ))
          )}
        </select>
      </div>

      <div
        className={getDropzoneClassName()}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={0}
        aria-label="Upload PDF files by dropping them here or clicking to select"
        aria-describedby="dropzone-description"
      >
        {/* Upload Icon */}
        <svg
          className={styles.icon}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
          />
        </svg>

        <h3 className={styles.title}>
          {dragError 
            ? selectedTemplateMeta.ingestionType === 'xls' ? 'Only XLS/XLSX files allowed!' : 'Only PDF files allowed!' 
            : isDragActive 
              ? 'Drop any document(s) here ✨' 
              : 'Drop any document(s) here ✨'
          }
        </h3>
        
        <p className={styles.subtitle} id="dropzone-description">
          {dragError 
            ? `Please drop only ${selectedTemplateMeta.ingestionType === 'xls' ? 'XLS/XLSX' : 'PDF'} files`
            : `or click to choose a ${selectedTemplateMeta.ingestionType === 'xls' ? 'XLS/XLSX' : 'PDF'} file`
          }
        </p>
        <p className={styles.hint}>
          Accepts: {selectedTemplateMeta.acceptExtensions.join(', ')} • Max {selectedTemplateMeta.maxSizeMb}MB
        </p>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={selectedTemplateMeta.acceptExtensions.join(',')}
          onChange={handleFileSelect}
          className={styles.fileInput}
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>

      {error && (
        <div className={styles.error} role="alert">
          {error}
          <button
            type="button"
            className={styles.errorDismiss}
            onClick={clearError}
            aria-label="Dismiss error message"
          >
            ×
          </button>
        </div>
      )}

      {files.length > 0 && (
        <div className={styles.fileList}>
          <h4 className={styles.fileListTitle}>
            Files ({files.length})
          </h4>
          
          <div className={styles.files} role="list">
            {files.map(file => (
              <FileItem
                key={file.id}
                file={file}
                onRemove={removeFile}
                onCancel={cancelUpload}
              />
            ))}
          </div>

          <div className={styles.actions}>
            {canUpload && (
              <button
                type="button"
                onClick={startUploads}
                disabled={isUploading}
                className={styles.uploadButton}
                aria-label="Start uploading all pending files"
              >
                {isUploading ? 'Uploading...' : (() => {
                  const pendingCount = files.filter(f => f.status === 'pending').length
                  return `Upload ${pendingCount} file${pendingCount !== 1 ? 's' : ''}`
                })()}
              </button>
            )}
            
            <button
              type="button"
              onClick={reset}
              className={styles.actionButton}
              aria-label="Clear all files from upload queue"
            >
              Clear All
            </button>
          </div>
        </div>
      )}

      {redirectCountdown !== null && (() => {
        const completedCount = files.filter(f => f.status === 'completed').length
        const duplicateCount = files.filter(f => f.status === 'deduplicated').length
        const totalFiles = files.length

        return (
          <div className={styles.successMessage}>
            <div className={styles.successTitle}>
              ✅ {totalFiles === 1 ? 'File' : 'Files'} processed successfully!
            </div>
            <div className={styles.successSubtitle}>
              {duplicateCount > 0 ? (
                <>
                  {completedCount} new file{completedCount !== 1 ? 's' : ''} uploaded
                  {duplicateCount > 0 && `, ${duplicateCount} duplicate${duplicateCount !== 1 ? 's' : ''} detected`}
                </>
              ) : (
                `${completedCount} file${completedCount !== 1 ? 's' : ''} uploaded`
              )}
            </div>
            <div className={styles.successSubtitle}>
              Redirecting to processing queue in <span className={styles.countdown}>{redirectCountdown}</span> second{redirectCountdown !== 1 ? 's' : ''}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
