import type { UploadedFile } from '@/types/files'

interface FileItemProps {
  file: UploadedFile
  onRemove: (fileId: string) => void
  onCancel: (fileId: string) => void
}

export function FileItem({ file, onRemove, onCancel }: FileItemProps) {
  const getStatusColor = () => {
    switch (file.status) {
      case 'completed': return '#22c55e'
      case 'deduplicated': return '#3b82f6'
      case 'processing': return '#f59e0b'
      case 'error': return '#ef4444'
      case 'cancelled': return '#6b7280'
      case 'uploading': return '#3b82f6'
      default: return '#6b7280'
    }
  }

  const getStatusText = () => {
    switch (file.status) {
      case 'completed': return 'Completed'
      case 'deduplicated':
        return file.duplicateOf
          ? `Identical to ${file.duplicateOf.filename}`
          : 'Duplicate (using existing job)'
      case 'processing': return file.processingMessage || 'Processing...'
      case 'error': return file.error || 'Upload failed'
      case 'cancelled': return 'Cancelled'
      case 'uploading': return `Uploading... ${Math.round(file.progress)}%`
      case 'pending': return 'Pending'
      default: return 'Unknown'
    }
  }

  const getStatusIcon = () => {
    switch (file.status) {
      case 'completed':
        return (
          <svg className="status-icon" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
        )
      case 'deduplicated':
        return (
          <svg className="status-icon" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
          </svg>
        )
      case 'processing':
        return (
          <svg className="status-icon spinner" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
          </svg>
        )
      case 'error':
        return (
          <svg className="status-icon" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
        )
      default:
        return null
    }
  }

  const canCancel = file.status === 'uploading' || file.status === 'pending'
  const canRemove = file.status === 'completed' || file.status === 'error' || file.status === 'cancelled' || file.status === 'deduplicated'

  return (
    <div className="file-item" role="listitem">
      <div className="file-info">
        <div className="file-name" title={file.name}>
          {file.name}
        </div>
        <div className="file-details">
          <span className="file-size">{file.sizeFormatted}</span>
          <span
            className="file-status"
            style={{ color: getStatusColor() }}
            aria-live="polite"
          >
            {getStatusIcon()}
            {getStatusText()}
          </span>
        </div>
        
        {(file.status === 'uploading' || file.status === 'pending' || file.status === 'processing') && (
          <div className="progress-container" aria-label={`Upload progress: ${file.progress}%`}>
            <div
              className="progress-bar"
              role="progressbar"
              aria-valuenow={file.progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Upload progress"
            >
              <div
                className={`progress-fill ${file.status === 'processing' ? 'processing' : ''}`}
                style={{ width: `${file.progress}%` }}
              />
            </div>
          </div>
        )}
      </div>

      <div className="file-actions">
        {canCancel && (
          <button
            type="button"
            onClick={() => onCancel(file.id)}
            className="action-button cancel-button"
            aria-label={`Cancel upload of ${file.name}`}
          >
            Cancel
          </button>
        )}
        
        {canRemove && (
          <button
            type="button"
            onClick={() => onRemove(file.id)}
            className="action-button remove-button"
            aria-label={`Remove ${file.name} from list`}
          >
            Remove
          </button>
        )}
      </div>

      <style jsx>{`
        .file-item {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          padding: 12px 16px;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          background: #f9fafb;
          gap: 16px;
        }

        .file-info {
          flex: 1;
          min-width: 0;
        }

        .file-name {
          font-weight: 500;
          font-size: 14px;
          color: #111827;
          margin-bottom: 4px;
          word-break: break-word;
        }

        .file-details {
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 12px;
          margin-bottom: 8px;
        }

        .file-size {
          color: #6b7280;
        }

        .file-status {
          font-weight: 500;
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .status-icon {
          width: 16px;
          height: 16px;
          flex-shrink: 0;
        }

        .status-icon.spinner {
          animation: spin 2s linear infinite;
        }

        @keyframes spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }

        .progress-container {
          margin-top: 8px;
        }

        .progress-bar {
          width: 100%;
          height: 4px;
          background-color: #e5e7eb;
          border-radius: 2px;
          overflow: hidden;
        }

        .progress-fill {
          height: 100%;
          background-color: #3b82f6;
          transition: width 0.2s ease-in-out;
        }

        .progress-fill.processing {
          background-color: #f59e0b;
        }

        .file-actions {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .action-button {
          padding: 4px 12px;
          font-size: 12px;
          font-weight: 500;
          border: 1px solid;
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.2s ease-in-out;
          min-width: 60px;
        }

        .action-button:focus {
          outline: 2px solid #3b82f6;
          outline-offset: 2px;
        }

        .cancel-button {
          background: #fff;
          color: #f59e0b;
          border-color: #f59e0b;
        }

        .cancel-button:hover {
          background: #fef3c7;
        }

        .remove-button {
          background: #fff;
          color: #ef4444;
          border-color: #ef4444;
        }

        .remove-button:hover {
          background: #fef2f2;
        }

        @media (max-width: 640px) {
          .file-item {
            flex-direction: column;
            align-items: stretch;
            gap: 12px;
          }

          .file-actions {
            flex-direction: row;
            align-self: flex-end;
          }
        }
      `}</style>
    </div>
  )
}