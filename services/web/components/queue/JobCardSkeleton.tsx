export function JobCardSkeleton() {
  return (
    <div className="flex flex-col justify-between h-full bg-white border border-gray-200 rounded-lg p-4 animate-pulse">
      <div>
        <div className="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
        <div className="h-3 bg-gray-200 rounded w-1/2 mb-4"></div>
      </div>
      <div className="flex gap-2 mt-4">
        <div className="h-8 bg-gray-200 rounded flex-1"></div>
        <div className="h-8 bg-gray-200 rounded flex-1"></div>
        <div className="h-8 bg-gray-200 rounded flex-1"></div>
      </div>
    </div>
  );
}
