interface Job {
  id: string;
  filename: string;
  bytes: number;
  status: string;
  mapping: string;
  createdAt: string;
  updatedAt: string;
  error: { code: string; message: string } | null;
  canDownload: boolean;
  hasArtifacts: boolean;
}

interface QueuePageHeaderProps {
  jobs: Job[];
  selectedJobIds: Set<string>;
  onUploadMore: () => void;
  onBulkDownload: () => void;
  onBulkDelete: () => void;
}

export function QueuePageHeader({ 
  jobs, 
  selectedJobIds, 
  onUploadMore, 
  onBulkDownload, 
  onBulkDelete 
}: QueuePageHeaderProps) {
  const stats = {
    total: jobs.length,
    processing: jobs.filter(j => j.status === 'processing').length,
    queued: jobs.filter(j => ['uploaded', 'queued'].includes(j.status)).length,
    completed: jobs.filter(j => j.status === 'complete').length
  };

  const formatSummary = () => {
    const parts = [];
    parts.push(`${stats.total} total`);
    if (stats.processing > 0) parts.push(`${stats.processing} processing`);
    if (stats.queued > 0) parts.push(`${stats.queued} queued`);
    if (stats.completed > 0) parts.push(`${stats.completed} completed`);
    return parts.join(' • ');
  };

  const selectedJobs = jobs.filter(job => selectedJobIds.has(job.id));
  const downloadableSelectedJobs = selectedJobs.filter(job => job.canDownload);
  const hasSelection = selectedJobIds.size > 0;
  const hasDownloadableSelection = downloadableSelectedJobs.length > 0;

  return (
    <div className="relative">
      {/* Left side - Title and stats */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Processing Queue</h1>
          <div className="flex items-center mt-1">
            <p className="text-sm text-gray-600" style={{ minWidth: 'fit-content' }}>
              {formatSummary()}
            </p>
            {/* Reserve fixed space for selection text to prevent shift */}
            <div className="flex items-center" style={{ minWidth: '200px' }}>
              {hasSelection && (
                <>
                  <span className="mx-2 text-gray-400 text-sm leading-5">•</span>
                  <span className="text-sm text-blue-700">
                    <span className="font-medium">{selectedJobIds.size}</span> job{selectedJobIds.size !== 1 ? 's' : ''} selected
                    {downloadableSelectedJobs.length !== selectedJobs.length && (
                      <span className="text-blue-600 ml-2">
                        ({downloadableSelectedJobs.length} downloadable)
                      </span>
                    )}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        
        {/* Right side - Buttons */}
        <div className="flex items-center gap-2">
          {/* Bulk Actions - Show when selection exists */}
          {hasSelection && (
            <>
              <button
                onClick={onBulkDownload}
                disabled={!hasDownloadableSelection}
                className={`action-button px-4 py-2 font-medium rounded-lg transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 min-w-[100px] ${
                  hasDownloadableSelection
                    ? 'bg-blue-600 hover:bg-blue-700 text-white focus:ring-blue-500'
                    : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                }`}
                title={hasDownloadableSelection ? `Download ZIP with ${downloadableSelectedJobs.length} XML file${downloadableSelectedJobs.length !== 1 ? 's' : ''}` : 'No downloadable jobs selected'}
              >
                Download XML
              </button>
              
              <button
                onClick={onBulkDelete}
                className="action-button px-4 py-2 font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 min-w-[100px]"
                title={`Delete ${selectedJobIds.size} job${selectedJobIds.size !== 1 ? 's' : ''}`}
              >
                Delete
              </button>
            </>
          )}

          {/* Upload More Button - Always visible */}
          <button
            onClick={onUploadMore}
            className="bg-blue-500 text-white px-4 py-2 font-medium rounded-lg hover:bg-blue-600 transition-colors duration-150 focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 min-w-[100px]"
          >
            Upload More Files
          </button>
        </div>
      </div>
    </div>
  );
}