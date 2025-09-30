interface ActionButtonsProps {
  jobId: string;
  canDownload: boolean;
  hasArtifacts: boolean;
  onDownload: (id: string) => void;
  onDownloadArtifact: (id: string) => void;
  onDelete: (id: string) => void;
  filename: string;
  canReview?: boolean;
}

export function ActionButtons({
  jobId,
  canDownload,
  hasArtifacts,
  onDownload,
  onDownloadArtifact,
  onDelete,
  filename,
  canReview = false
}: ActionButtonsProps) {
  const handleReview = () => {
    window.open(`/review/${jobId}`, '_blank');
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleReview}
        disabled={!canReview}
        className={canReview
          ? "action-button px-3 py-1.5 text-xs font-semibold text-white bg-purple-600 hover:bg-purple-700 rounded-md shadow-sm transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-1"
          : "action-button px-3 py-1.5 text-xs font-semibold text-gray-500 bg-gray-300 rounded-md shadow-sm cursor-not-allowed"
        }
        title={canReview ? `Review invoice for ${filename}` : 'Processing not complete'}
        aria-label={canReview ? `Review invoice for ${filename}` : 'Processing not complete'}
      >
        Review
      </button>

      <button
        onClick={() => canDownload ? onDownload(jobId) : undefined}
        disabled={!canDownload}
        className={canDownload
          ? "action-button px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md shadow-sm transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
          : "action-button px-3 py-1.5 text-xs font-semibold text-gray-500 bg-gray-300 rounded-md shadow-sm cursor-not-allowed"
        }
        title={canDownload ? `Download XML for ${filename}` : 'Processing not complete'}
        aria-label={canDownload ? `Download XML for ${filename}` : 'Processing not complete'}
      >
        XML
      </button>
      
      <button
        onClick={() => (canDownload && hasArtifacts) ? onDownloadArtifact(jobId) : undefined}
        disabled={!canDownload || !hasArtifacts}
        className={(canDownload && hasArtifacts)
          ? "action-button px-3 py-1.5 text-xs font-semibold text-white bg-green-600 hover:bg-green-700 rounded-md shadow-sm transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-1"
          : "action-button px-3 py-1.5 text-xs font-semibold text-gray-500 bg-gray-300 rounded-md shadow-sm cursor-not-allowed"
        }
        title={canDownload ? (hasArtifacts ? `Download Artifact for ${filename}` : 'No artifacts available') : 'Processing not complete'}
        aria-label={canDownload ? (hasArtifacts ? `Download Artifact for ${filename}` : 'No artifacts available') : 'Processing not complete'}
      >
        Artifact
      </button>
      
      <button
        onClick={() => onDelete(jobId)}
        className="action-button px-3 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-md shadow-sm transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1"
        title={`Delete ${filename}`}
        aria-label={`Delete ${filename}`}
      >
        Delete
      </button>
    </div>
  );
}