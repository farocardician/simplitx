'use client'

import { useState, useCallback } from 'react'
import type { UploadedFile, UploadState, UploadProgress } from '@/types/files'
import { formatBytes, exceedsLimit } from '@/lib/bytes'
import { isValidPDF, getPDFValidationError } from '@/lib/mime'

const MAX_FILE_SIZE_MB = 50
const MAX_CONCURRENT_UPLOADS = 3

export function useUpload() {
  const [uploadState, setUploadState] = useState<UploadState>({
    files: [],
    isUploading: false,
    error: null
  })

  const generateFileId = useCallback(() => {
    return `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }, [])

  const addFiles = useCallback((newFiles: File[]) => {
    const validFiles: UploadedFile[] = []
    const errors: string[] = []

    newFiles.forEach(file => {
      // Check for duplicates by name and size
      const isDuplicate = uploadState.files.some(
        existingFile => existingFile.name === file.name && existingFile.size === file.size
      )

      if (isDuplicate) {
        errors.push(`"${file.name}" is already in the upload queue`)
        return
      }

      // Validate PDF format
      if (!isValidPDF(file)) {
        errors.push(getPDFValidationError(file))
        return
      }

      // Check file size
      if (exceedsLimit(file.size, MAX_FILE_SIZE_MB)) {
        errors.push(`"${file.name}" is too large. Maximum size is ${MAX_FILE_SIZE_MB}MB`)
        return
      }

      validFiles.push({
        id: generateFileId(),
        file,
        name: file.name,
        size: file.size,
        sizeFormatted: formatBytes(file.size),
        progress: 0,
        status: 'pending',
        abortController: new AbortController()
      })
    })

    if (validFiles.length > 0) {
      setUploadState(prev => ({
        ...prev,
        files: [...prev.files, ...validFiles],
        error: errors.length > 0 ? errors.join('; ') : null
      }))
    } else if (errors.length > 0) {
      setUploadState(prev => ({
        ...prev,
        error: errors.join('; ')
      }))
    }

    return validFiles
  }, [uploadState.files, generateFileId])

  const removeFile = useCallback((fileId: string) => {
    setUploadState(prev => {
      const file = prev.files.find(f => f.id === fileId)
      if (file?.abortController) {
        file.abortController.abort()
      }
      
      return {
        ...prev,
        files: prev.files.filter(f => f.id !== fileId)
      }
    })
  }, [])

  const cancelUpload = useCallback((fileId: string) => {
    setUploadState(prev => ({
      ...prev,
      files: prev.files.map(file => {
        if (file.id === fileId && file.abortController) {
          file.abortController.abort()
          return { ...file, status: 'cancelled' as const }
        }
        return file
      })
    }))
  }, [])

  const updateFileProgress = useCallback((progress: UploadProgress) => {
    setUploadState(prev => ({
      ...prev,
      files: prev.files.map(file => 
        file.id === progress.fileId 
          ? { ...file, progress: progress.progress, status: progress.status, error: progress.error }
          : file
      )
    }))
  }, [])

  const realUpload = useCallback(async (fileId: string) => {
    const fileData = uploadState.files.find(f => f.id === fileId)
    if (!fileData) return

    updateFileProgress({ fileId, progress: 0, status: 'uploading' })

    try {
      const formData = new FormData()
      formData.append('file', fileData.file)

      // Use XMLHttpRequest for upload progress
      const xhr = new XMLHttpRequest()
      
      return new Promise<void>((resolve, reject) => {
        // Track upload progress
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const progress = Math.round((e.loaded / e.total) * 100)
            updateFileProgress({ 
              fileId, 
              progress, 
              status: progress === 100 ? 'completed' : 'uploading' 
            })
          }
        })

        // Handle completion
        xhr.addEventListener('load', () => {
          if (xhr.status === 200) {
            updateFileProgress({ fileId, progress: 100, status: 'completed' })
            
            // Parse response to check if job was created successfully
            try {
              const response = JSON.parse(xhr.responseText)
              if (response.job) {
                // Redirect to queue page on successful job creation
                setTimeout(() => {
                  window.location.href = '/queue'
                }, 500) // Small delay to show completion
              }
            } catch (e) {
              console.log('Response parsing error:', e)
            }
            
            resolve()
          } else {
            updateFileProgress({ 
              fileId, 
              progress: 0, 
              status: 'error', 
              error: `Upload failed: ${xhr.statusText}` 
            })
            reject(new Error(xhr.statusText))
          }
        })

        // Handle errors
        xhr.addEventListener('error', () => {
          updateFileProgress({ 
            fileId, 
            progress: 0, 
            status: 'error', 
            error: 'Upload failed. Please try again.' 
          })
          reject(new Error('Upload failed'))
        })

        // Handle abort
        xhr.addEventListener('abort', () => {
          updateFileProgress({ fileId, progress: 0, status: 'cancelled' })
          resolve()
        })

        // Connect abort controller
        if (fileData.abortController) {
          fileData.abortController.signal.addEventListener('abort', () => {
            xhr.abort()
          })
        }

        // Start upload
        xhr.open('POST', '/api/upload')
        xhr.send(formData)
      })
    } catch (error) {
      updateFileProgress({ 
        fileId, 
        progress: 0, 
        status: 'error', 
        error: 'Upload failed. Please try again.' 
      })
    }
  }, [uploadState.files, updateFileProgress])

  const startUploads = useCallback(async () => {
    const pendingFiles = uploadState.files.filter(f => f.status === 'pending')
    if (pendingFiles.length === 0) return

    setUploadState(prev => ({ ...prev, isUploading: true, error: null }))

    // Process uploads with concurrency limit
    const chunks = []
    for (let i = 0; i < pendingFiles.length; i += MAX_CONCURRENT_UPLOADS) {
      chunks.push(pendingFiles.slice(i, i + MAX_CONCURRENT_UPLOADS))
    }

    for (const chunk of chunks) {
      await Promise.all(chunk.map(file => realUpload(file.id)))
    }

    setUploadState(prev => ({ ...prev, isUploading: false }))
  }, [uploadState.files, realUpload])

  const clearError = useCallback(() => {
    setUploadState(prev => ({ ...prev, error: null }))
  }, [])

  const reset = useCallback(() => {
    // Cancel all ongoing uploads
    uploadState.files.forEach(file => {
      if (file.abortController) {
        file.abortController.abort()
      }
    })

    setUploadState({
      files: [],
      isUploading: false,
      error: null
    })
  }, [uploadState.files])

  return {
    ...uploadState,
    addFiles,
    removeFile,
    cancelUpload,
    startUploads,
    clearError,
    reset,
    canUpload: uploadState.files.some(f => f.status === 'pending')
  }
}