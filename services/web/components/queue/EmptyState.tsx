export function EmptyState({ 
  onUploadFiles 
}: { 
  onUploadFiles: () => void;
}) {
  return (
    <div className="text-center py-12">
      <div className="max-w-md mx-auto">
        <div className="mb-4">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
        </div>
        
        <h3 className="text-lg font-medium text-gray-900 mb-2">
          No files in queue
        </h3>
        
        <p className="text-gray-600 mb-6">
          Upload your first PDF file to start processing
        </p>
        
        <button
          onClick={onUploadFiles}
          className="bg-blue-500 text-white px-6 py-2 rounded hover:bg-blue-600 transition-colors"
        >
          Upload Files
        </button>
      </div>
    </div>
  );
}