import { STATUS_DISPLAY_MAP, STATUS_COLORS, type DisplayStatus } from '../utils/constants';

interface StatusChipProps {
  status: string;
}

export function StatusChip({ status }: StatusChipProps) {
  const displayStatus = STATUS_DISPLAY_MAP[status as keyof typeof STATUS_DISPLAY_MAP] || 'queued';
  const colors = STATUS_COLORS[displayStatus as DisplayStatus];

  const capitalizedStatus = displayStatus.charAt(0).toUpperCase() + displayStatus.slice(1);

  return (
    <span 
      className={`
        inline-flex px-2 py-0.5 rounded-full text-xs font-medium border
        ${colors.bg} ${colors.text} ${colors.border}
      `}
      aria-label={`Status: ${capitalizedStatus}`}
    >
      {capitalizedStatus}
    </span>
  );
}