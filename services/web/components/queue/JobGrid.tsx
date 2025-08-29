import { JobCard } from './JobCard';

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

export function JobGrid({
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
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 auto-rows-fr">
      {jobs.map(job => (
        <JobCard
          key={job.id}
          job={job}
          onDownload={onDownload}
          onDownloadArtifact={onDownloadArtifact}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
