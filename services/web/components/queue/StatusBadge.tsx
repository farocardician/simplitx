export function StatusBadge({ status }: { status: string }) {
  const config = {
    uploaded: { 
      label: 'Queued', 
      className: 'bg-gray-100 text-gray-700' 
    },
    queued: { 
      label: 'Waiting', 
      className: 'bg-yellow-100 text-yellow-700' 
    },
    processing: { 
      label: 'Processing...', 
      className: 'bg-blue-100 text-blue-700 animate-pulse' 
    },
    complete: { 
      label: 'Ready', 
      className: 'bg-green-100 text-green-700' 
    },
    failed: { 
      label: 'Failed', 
      className: 'bg-red-100 text-red-700' 
    }
  };
  
  const { label, className } = config[status as keyof typeof config] || config.uploaded;
  
  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}