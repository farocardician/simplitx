import { GRID_COLUMNS } from '../utils/constants';

interface QueueGridHeaderProps {
  selectedJobIds: Set<string>;
  allJobIds: string[];
  onSelectAll: () => void;
  onClearSelection: () => void;
}

export function QueueGridHeader({
  selectedJobIds,
  allJobIds,
  onSelectAll,
  onClearSelection
}: QueueGridHeaderProps) {
  const isAllSelected = allJobIds.length > 0 && selectedJobIds.size === allJobIds.length;
  const isIndeterminate = selectedJobIds.size > 0 && selectedJobIds.size < allJobIds.length;

  const handleSelectAllChange = () => {
    if (isAllSelected) {
      onClearSelection();
    } else {
      onSelectAll();
    }
  };

  return (
    <thead className="sticky top-0 bg-gray-50 z-10 shadow-sm">
      <tr className="border-b-2 border-gray-200">
        {GRID_COLUMNS.map((column, index) => (
          <th
            key={column.key}
            className={`
              px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider
              ${column.width}
              ${column.align || ''}
              ${index === 0 ? 'rounded-tl-lg' : ''}
              ${index === GRID_COLUMNS.length - 1 ? 'rounded-tr-lg' : ''}
            `}
          >
            {column.key === 'select' ? (
              <input
                type="checkbox"
                checked={isAllSelected}
                ref={(input) => {
                  if (input) input.indeterminate = isIndeterminate;
                }}
                onChange={handleSelectAllChange}
                className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 focus:ring-2"
                aria-label="Select all jobs"
              />
            ) : (
              column.label
            )}
          </th>
        ))}
      </tr>
    </thead>
  );
}