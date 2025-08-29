export function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mb-6 bg-red-50 border border-red-200 text-red-700 p-4 rounded">
      <div className="flex items-center justify-between">
        <span>{message}</span>
        <button onClick={onRetry} className="underline text-sm font-medium">
          Try again
        </button>
      </div>
    </div>
  );
}
