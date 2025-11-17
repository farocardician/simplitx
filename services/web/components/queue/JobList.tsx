import { StatusBadge } from './StatusBadge';
import { formatDistanceToNow } from 'date-fns';

interface Job {
  id: string;
  filename: string;
  sizeFormatted: string;
  status: string;
  mapping: string;
  createdAt: string;
  completedAt: string | null;
  error: { code: string; message: string } | null;
  canDownload: boolean;
  hasArtifacts: boolean;
}

export function JobList({ 
  jobs, 
  onDownload,
  onDownloadArtifact,
  onDelete
}: { 
  jobs: Job[]; 
  onDownload: (id: string) => void;
  onDownloadArtifact: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      {jobs.map(job => (
        <div 
          key={job.id}
          className="bg-white rounded-lg shadow p-4 md:p-6"
        >
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            {/* File Info */}
            <div className="flex-1">
              <h3 className="font-medium text-gray-900 truncate">
                {job.filename}
              </h3>
              <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
                <span>{job.sizeFormatted}</span>
                <span>•</span>
                <span>{job.mapping}</span>
                <span>•</span>
                <span>
                  {formatDistanceToNow(new Date(job.createdAt), { 
                    addSuffix: true 
                  })}
                </span>
              </div>
            </div>
            
            {/* Status */}
            <div className="flex items-center gap-4">
              <StatusBadge status={job.status} />
              
              {/* Actions */}
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => onDownload(job.id)}
                  disabled={!job.canDownload}
                  className={`
                    px-3 py-1 text-sm rounded
                    ${job.canDownload 
                      ? 'bg-blue-500 text-white hover:bg-blue-600' 
                      : 'bg-gray-200 text-gray-400 cursor-not-allowed'}
                  `}
                >
                  Download XML
                </button>
                
                <button
                  onClick={() => onDownloadArtifact(job.id)}
                  disabled={!job.hasArtifacts}
                  className={`
                    px-3 py-1 text-sm rounded
                    ${job.hasArtifacts 
                      ? 'bg-green-500 text-white hover:bg-green-600' 
                      : 'bg-gray-200 text-gray-400 cursor-not-allowed'}
                  `}
                >
                  Download Artifact
                </button>
                
                <button
                  onClick={() => onDelete(job.id)}
                  className="px-3 py-1 text-sm rounded bg-red-500 text-white hover:bg-red-600"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
          
          {/* Error Message */}
          {job.error && (
            <div className="mt-3 p-2 bg-red-50 text-red-700 rounded text-sm">
              {job.error.message}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}