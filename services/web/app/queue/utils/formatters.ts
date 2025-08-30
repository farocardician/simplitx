/**
 * Utility functions for formatting data in the queue page
 */

/**
 * Format file size in bytes to human-readable string
 */
export function humanBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  if (i === 0) return `${bytes} B`;
  if (i === 1) return `${(bytes / k).toFixed(1).replace(/\.0$/, '')} KB`;
  if (i === 2) return `${(bytes / Math.pow(k, 2)).toFixed(1).replace(/\.0$/, '')} MB`;
  
  return `${(bytes / Math.pow(k, 3)).toFixed(2).replace(/\.00$/, '').replace(/\.0$/, '')} GB`;
}

/**
 * Extract short form from mime type
 * Since API doesn't provide content_type, defaults to PDF
 */
export function mimeShort(mimeType?: string | null): string {
  if (!mimeType) return 'PDF';
  
  const mimeMap: Record<string, string> = {
    'application/pdf': 'PDF',
    'application/x-pdf': 'PDF',
    'text/csv': 'CSV',
    'application/csv': 'CSV',
    'image/jpeg': 'JPG',
    'image/jpg': 'JPG',
    'image/png': 'PNG',
    'application/json': 'JSON',
    'text/xml': 'XML',
    'application/xml': 'XML'
  };

  return mimeMap[mimeType.toLowerCase()] || 'PDF';
}

/**
 * Truncate filename in the middle to preserve start and extension
 */
export function middleTruncate(filename: string, maxLength: number = 48): string {
  if (filename.length <= maxLength) return filename;

  const keepStart = Math.ceil((maxLength - 3) * 0.6);
  const keepEnd = Math.floor((maxLength - 3) * 0.4);

  return `${filename.slice(0, keepStart)}...${filename.slice(-keepEnd)}`;
}

/**
 * Convert ISO timestamp to human-readable age
 */
export function age(isoTimestamp: string): string {
  const now = new Date();
  const then = new Date(isoTimestamp);
  const diffMs = now.getTime() - then.getTime();

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  if (days < 7) return `${days} d${days === 1 ? '' : 's'} ago`;
  
  return `${weeks} wk${weeks === 1 ? '' : 's'} ago`;
}