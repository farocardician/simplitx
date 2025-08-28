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
      case 'error': return '#ef4444'  
      case 'cancelled': return '#6b7280'
      case 'uploading': return '#3b82f6'
      default: return '#6b7280'
    }
  }

  const getStatusText = () => {
    switch (file.status) {
      case 'completed': return 'Completed'
      case 'error': return file.error || 'Upload failed'
      case 'cancelled': return 'Cancelled'
      case 'uploading': return `Uploading... ${Math.round(file.progress)}%`
      case 'pending': return 'Pending'
      default: return 'Unknown'
    }
  }

  const canCancel = file.status === 'uploading' || file.status === 'pending'
  const canRemove = file.status === 'completed' || file.status === 'error' || file.status === 'cancelled'

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
            {getStatusText()}
          </span>
        </div>
        
        {(file.status === 'uploading' || file.status === 'pending') && (
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
                className="progress-fill"
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