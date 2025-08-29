import { StatusBadge } from './StatusBadge';

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

function middleTruncate(str: string, maxLength = 30) {
  if (str.length <= maxLength) return str;
  const half = Math.floor((maxLength - 3) / 2);
  return str.slice(0, half) + '...' + str.slice(str.length - half);
}

export function JobCard({
  job,
  onDownload,
  onDownloadArtifact,
  onDelete
}: {
  job: Job;
  onDownload: (id: string) => void;
  onDownloadArtifact: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex flex-col justify-between h-full bg-white border border-gray-200 rounded-lg p-4 transition-shadow hover:shadow">
      <div>
        <div className="flex items-start justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-900 leading-5 flex-1 mr-2 truncate">
            {middleTruncate(job.filename, 40)}
          </h3>
          <StatusBadge status={job.status} />
        </div>
        <div className="text-xs text-gray-500 space-x-1">
          <span>{job.sizeFormatted}</span>
          <span>•</span>
          <span>{job.mapping}</span>
        </div>
        {job.error && (
          <div className="mt-3 text-xs text-red-600">{job.error.message}</div>
        )}
      </div>
      <div className="flex gap-2 mt-4">
        <button
          onClick={() => onDownload(job.id)}
          disabled={!job.canDownload}
          className={`flex-1 px-2 py-1 text-xs rounded border transition-colors ${
            job.canDownload
              ? 'border-blue-200 text-blue-700 hover:bg-blue-50'
              : 'border-gray-200 text-gray-400 cursor-not-allowed'
          }`}
        >
          Download XML
        </button>
        <button
          onClick={() => onDownloadArtifact(job.id)}
          disabled={!job.hasArtifacts}
          className={`flex-1 px-2 py-1 text-xs rounded border transition-colors ${
            job.hasArtifacts
              ? 'border-green-200 text-green-700 hover:bg-green-50'
              : 'border-gray-200 text-gray-400 cursor-not-allowed'
          }`}
        >
          Download Artifact
        </button>
        <button
          onClick={() => onDelete(job.id)}
          className="flex-1 px-2 py-1 text-xs rounded border border-red-200 text-red-700 hover:bg-red-50"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
