export interface UploadedFile {
  id: string
  file: File
  name: string
  size: number
  sizeFormatted: string
  progress: number
  status: 'pending' | 'uploading' | 'completed' | 'error' | 'cancelled' | 'deduplicated'
  error?: string
  abortController?: AbortController
  duplicateOf?: {
    jobId: string
    filename: string
  }
}

export interface UploadState {
  files: UploadedFile[]
  isUploading: boolean
  error: string | null
}

export type UploadStatus = UploadedFile['status']

export interface UploadProgress {
  fileId: string
  progress: number
  status: UploadStatus
  error?: string
}