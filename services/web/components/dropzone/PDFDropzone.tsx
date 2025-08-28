'use client'

import { useRef, useState, useCallback } from 'react'
import { useUpload } from '@/hooks/useUpload'
import { FileItem } from './FileItem'
import styles from './PDFDropzone.module.css'

export function PDFDropzone() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragActive, setIsDragActive] = useState(false)
  const [dragError, setDragError] = useState(false)
  
  const {
    files,
    isUploading,
    error,
    addFiles,
    removeFile,
    cancelUpload,
    startUploads,
    clearError,
    reset,
    canUpload
  } = useUpload()

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
    
    // Check if dragged items contain any non-PDF files
    const hasInvalidFiles = Array.from(e.dataTransfer.items).some(item => {
      return item.kind === 'file' && !item.type.includes('pdf')
    })
    
    setDragError(hasInvalidFiles)
  }, [])

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
            ? 'Only PDF files allowed!' 
            : isDragActive 
              ? 'Drop your PDF here ✨' 
              : 'Drop your PDF here ✨'
          }
        </h3>
        
        <p className={styles.subtitle} id="dropzone-description">
          {dragError 
            ? 'Please drop only PDF files'
            : 'or click to choose a file'
          }
        </p>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,application/pdf"
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
                {isUploading ? 'Uploading...' : `Upload ${files.filter(f => f.status === 'pending').length} file(s)`}
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
    </div>
  )
}