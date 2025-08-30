/**
 * Constants and mappings for the queue page
 */

/**
 * Map backend status to display status
 */
export const STATUS_DISPLAY_MAP = {
  'uploaded': 'queued',    // Map uploaded to queued for display
  'queued': 'queued',
  'processing': 'processing',
  'complete': 'completed',
  'failed': 'failed'
} as const;

export type DisplayStatus = typeof STATUS_DISPLAY_MAP[keyof typeof STATUS_DISPLAY_MAP];

/**
 * Status color configurations using Tailwind classes
 */
export const STATUS_COLORS = {
  'queued': {
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    border: 'border-amber-200'
  },
  'processing': {
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    border: 'border-blue-200'
  },
  'completed': {
    bg: 'bg-emerald-50',
    text: 'text-emerald-700',
    border: 'border-emerald-200'
  },
  'failed': {
    bg: 'bg-rose-50',
    text: 'text-rose-700',
    border: 'border-rose-200'
  }
} as const;

/**
 * Grid column configurations
 */
export const GRID_COLUMNS = [
  { key: 'select', label: '', width: 'w-12', align: 'text-center' },
  { key: 'file', label: 'File', width: 'w-2/5', align: '' },
  { key: 'status', label: 'Status', width: 'w-24', align: '' },
  { key: 'mapping', label: 'Mapping', width: 'w-32', align: '' },
  { key: 'size', label: 'Size / Type', width: 'w-32', align: '' },
  { key: 'age', label: 'Age', width: 'w-24', align: '' },
  { key: 'progress', label: 'Progress / Error', width: 'w-48', align: '' },
  { key: 'actions', label: 'Actions', width: 'w-40', align: 'text-right' }
] as const;