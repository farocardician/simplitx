interface ProgressCellProps {
  status: string;
  error: { code: string; message: string } | null;
}

export function ProgressCell({ status, error }: ProgressCellProps) {
  if (status === 'processing') {
    return (
      <div className="w-full">
        <div className="w-full bg-blue-200 rounded-full h-2 overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full progress-indeterminate" />
        </div>
      </div>
    );
  }

  if (status === 'failed' && error?.message) {
    return (
      <div className="text-xs text-red-600 truncate" title={error.message}>
        {error.message}
      </div>
    );
  }

  return (
    <span className="text-gray-400 text-sm">—</span>
  );
}