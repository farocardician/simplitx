import { QueueGridHeader } from './QueueGridHeader';
import { QueueGridRow } from './QueueGridRow';

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
  approved: boolean;
  approvedAt: string | null;
}

interface QueueDataGridProps {
  jobs: Job[];
  selectedJobIds: Set<string>;
  onDownload: (id: string) => void;
  onDownloadArtifact: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
}

export function QueueDataGrid({
  jobs,
  selectedJobIds,
  onDownload,
  onDownloadArtifact,
  onDelete,
  onToggleSelect,
  onSelectAll,
  onClearSelection
}: QueueDataGridProps) {
  if (jobs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="text-gray-500 text-lg mb-4">No jobs in queue</div>
        <button
          onClick={() => window.location.href = '/'}
          className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 transition-colors"
        >
          Upload Files
        </button>
      </div>
    );
  }

  const allJobIds = jobs.map(job => job.id);

  return (
    <div className="overflow-x-auto border border-gray-200 rounded-lg">
      <table className="min-w-full divide-y divide-gray-200">
        <QueueGridHeader 
          selectedJobIds={selectedJobIds}
          allJobIds={allJobIds}
          onSelectAll={onSelectAll}
          onClearSelection={onClearSelection}
        />
        <tbody className="bg-white divide-y divide-gray-100">
          {jobs.map((job, index) => (
            <QueueGridRow
              key={job.id}
              job={job}
              isLast={index === jobs.length - 1}
              isSelected={selectedJobIds.has(job.id)}
              onDownload={onDownload}
              onDownloadArtifact={onDownloadArtifact}
              onDelete={onDelete}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </tbody>
      </table>
      
      {/* Footer sentinel */}
      <div className="text-center py-4 text-sm text-gray-500 bg-gray-50 rounded-b-lg border-t border-gray-100">
        No more jobs to load
      </div>
    </div>
  );
}