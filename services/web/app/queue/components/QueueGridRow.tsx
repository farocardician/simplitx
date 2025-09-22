import { StatusChip } from './StatusChip';
import { ProgressCell } from './ProgressCell';
import { ActionButtons } from './ActionButtons';
import { humanBytes, mimeShort, middleTruncate, age } from '../utils/formatters';

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

interface QueueGridRowProps {
  job: Job;
  isLast?: boolean;
  isSelected: boolean;
  onDownload: (id: string) => void;
  onDownloadArtifact: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleSelect: (id: string) => void;
}

export function QueueGridRow({
  job,
  isLast,
  isSelected,
  onDownload,
  onDownloadArtifact,
  onDelete,
  onToggleSelect
}: QueueGridRowProps) {
  return (
    <tr className={`hover:bg-gray-50 transition-all duration-150 border-b border-gray-100 ${isSelected ? 'bg-blue-50' : ''}`}>
      {/* Select */}
      <td className="px-4 py-3 text-center">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(job.id)}
          className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 focus:ring-2"
          aria-label={`Select ${job.filename}`}
        />
      </td>
      
      {/* File */}
      <td className={`px-4 py-3 text-sm font-medium text-gray-900`} title={job.filename}>
        {middleTruncate(job.filename, 48)}
      </td>
      
      {/* Status */}
      <td className="px-4 py-3">
        <StatusChip status={job.status} />
      </td>

      {/* Approved */}
      <td className="px-4 py-3 text-center">
        <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${
          job.approved
            ? 'bg-green-100 text-green-800'
            : 'bg-gray-100 text-gray-600'
        }`}>
          {job.approved ? 'Yes' : 'No'}
        </span>
      </td>

      {/* Mapping */}
      <td className="px-4 py-3 text-sm text-gray-600">
        {job.mapping}
      </td>
      
      {/* Size / Type */}
      <td className="px-4 py-3 text-sm text-gray-600">
        {humanBytes(job.bytes)} • {mimeShort()}
      </td>
      
      {/* Age */}
      <td className="px-4 py-3 text-sm text-gray-600">
        {age(job.updatedAt || job.createdAt)}
      </td>
      
      {/* Progress / Error */}
      <td className="px-4 py-3">
        <ProgressCell status={job.status} error={job.error} />
      </td>
      
      {/* Actions */}
      <td className={`px-4 py-3 text-right ${isLast ? 'rounded-br-lg' : ''}`}>
        <ActionButtons
          jobId={job.id}
          canDownload={job.canDownload}
          hasArtifacts={job.hasArtifacts}
          onDownload={onDownload}
          onDownloadArtifact={onDownloadArtifact}
          onDelete={onDelete}
          filename={job.filename}
        />
      </td>
    </tr>
  );
}