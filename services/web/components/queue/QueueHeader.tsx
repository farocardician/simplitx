export function QueueHeader({ 
  totalJobs, 
  activeJobs, 
  onUploadMore 
}: { 
  totalJobs: number; 
  activeJobs: number;
  onUploadMore: () => void;
}) {
  return (
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Processing Queue</h1>
        <p className="text-gray-600 mt-1">
          {totalJobs} total jobs • {activeJobs} processing
        </p>
      </div>
      
      <button
        onClick={onUploadMore}
        className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 transition-colors"
      >
        Upload More Files
      </button>
    </div>
  );
}