'use client'

import { useState, useCallback, useRef } from 'react'
import type { UploadedFile, UploadState, UploadProgress } from '@/types/files'
import { formatBytes, exceedsLimit } from '@/lib/bytes'
import { isValidPDF, getPDFValidationError, isValidExcel, getExcelValidationError } from '@/lib/mime'

const MAX_FILE_SIZE_MB = 100
const MAX_CONCURRENT_UPLOADS = 3

type IngestionType = 'pdf' | 'xls'

export interface TemplateMeta {
  ingestionType: IngestionType
  uploadEndpoint: string
  queuePage: string
  acceptExtensions: string[]
  maxSizeMb: number
}

export function useUpload(options?: { getTemplate?: () => string; getTemplateMeta?: () => TemplateMeta | null }) {
  const [uploadState, setUploadState] = useState<UploadState>({
    files: [],
    isUploading: false,
    error: null
  })
  const [redirectCountdown, setRedirectCountdown] = useState<number | null>(null)
  const redirectIntervalRef = useRef<NodeJS.Timeout>()

  const resolveTemplateMeta = useCallback((): TemplateMeta => {
    const meta = options?.getTemplateMeta?.()
    return {
      ingestionType: meta?.ingestionType || 'pdf',
      uploadEndpoint: meta?.uploadEndpoint || '/api/upload',
      queuePage: meta?.queuePage || '/queue',
      acceptExtensions: meta?.acceptExtensions || ['.pdf'],
      maxSizeMb: meta?.maxSizeMb || MAX_FILE_SIZE_MB
    }
  }, [options?.getTemplateMeta])

  const generateFileId = useCallback(() => {
    return `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }, [])

  const addFiles = useCallback((newFiles: File[]) => {
    const validFiles: UploadedFile[] = []
    const errors: string[] = []
    const meta = resolveTemplateMeta()

    newFiles.forEach(file => {
      // Check for duplicates by name and size
      const isDuplicate = uploadState.files.some(
        existingFile => existingFile.name === file.name && existingFile.size === file.size
      )

      if (isDuplicate) {
        errors.push(`"${file.name}" is already in the upload queue`)
        return
      }

      // Validate file type
      const isValidType = meta.ingestionType === 'xls' ? isValidExcel(file) : isValidPDF(file)
      if (!isValidType) {
        const message = meta.ingestionType === 'xls'
          ? getExcelValidationError(file)
          : getPDFValidationError(file)
        errors.push(message)
        return
      }

      // Check file size
      const maxSize = meta.maxSizeMb || MAX_FILE_SIZE_MB
      if (exceedsLimit(file.size, maxSize)) {
        errors.push(`"${file.name}" is too large. Maximum size is ${maxSize}MB`)
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
  }, [uploadState.files, generateFileId, resolveTemplateMeta])

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
    const meta = resolveTemplateMeta()
    const fileData = uploadState.files.find(f => f.id === fileId)
    if (!fileData) return

    updateFileProgress({ fileId, progress: 0, status: 'uploading' })

    try {
      const formData = new FormData()
      formData.append('file', fileData.file)
      // Forward selected template (if provided) so backend enqueues with it
      try {
        const tpl = options?.getTemplate?.() || ''
        if (tpl) {
          formData.append('template', tpl)
        }
      } catch {}

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
            // Parse response to check if job was created successfully
            try {
              const response = JSON.parse(xhr.responseText)
              const isDuplicate = response.duplicate && response.original_filename

              if (isDuplicate) {
                setUploadState(prev => ({
                  ...prev,
                  files: prev.files.map(file =>
                    file.id === fileId
                      ? {
                          ...file,
                          progress: 100,
                          status: 'deduplicated' as const,
                          duplicateOf: {
                            jobId: response.original_job_id,
                            filename: response.original_filename
                          }
                        }
                      : file
                  )
                }))
              } else {
                // Regular completion
                updateFileProgress({ fileId, progress: 100, status: 'completed' })
              }

              // Check if all uploads are complete after this one
              setTimeout(() => {
                setUploadState(current => {
                  const allCompleted = current.files.every(f =>
                    f.status === 'completed' || f.status === 'deduplicated'
                  )
                  if (allCompleted) {
                    startRedirectCountdown(meta.queuePage)
                  }
                  return current
                })
              }, 100)
            } catch (e) {
              console.log('Response parsing error:', e)
              updateFileProgress({ fileId, progress: 100, status: 'completed' })
              setTimeout(() => {
                setUploadState(current => {
                  const allCompleted = current.files.every(f =>
                    f.status === 'completed' || f.status === 'deduplicated'
                  )
                  if (allCompleted) {
                    startRedirectCountdown(meta.queuePage)
                  }
                  return current
                })
              }, 100)
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
        xhr.open('POST', meta.uploadEndpoint || '/api/upload')
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
  }, [uploadState.files, updateFileProgress, options?.getTemplate, resolveTemplateMeta])

  const startRedirectCountdown = useCallback((targetPath: string = '/queue') => {
    // Clear any existing interval
    if (redirectIntervalRef.current) {
      clearInterval(redirectIntervalRef.current)
    }
    
    console.log('Starting countdown at 3')
    setRedirectCountdown(3)
    
    redirectIntervalRef.current = setInterval(() => {
      setRedirectCountdown((prev) => {
        console.log('Countdown tick, prev:', prev)
        if (prev === null) return null
        
        if (prev === 1) {
          console.log('Countdown reached 1, redirecting...')
          clearInterval(redirectIntervalRef.current!)
          window.location.href = targetPath
          return null
        }
        
        const nextValue = prev - 1
        console.log('Setting countdown to:', nextValue)
        return nextValue
      })
    }, 1000)
  }, [])

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
  }, [uploadState.files, realUpload, startRedirectCountdown])

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
    redirectCountdown,
    addFiles,
    removeFile,
    cancelUpload,
    startUploads,
    clearError,
    reset,
    canUpload: uploadState.files.some(f => f.status === 'pending')
  }
}
