/**
 * Format file size in bytes to human-readable string
 */
export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return '0 B'

  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']

  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
}

/**
 * Parse human-readable size to bytes
 */
export function parseBytes(sizeStr: string): number {
  const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B)$/i)
  if (!match) return 0

  const [, numStr, unit] = match
  const num = parseFloat(numStr)
  const multipliers: Record<string, number> = {
    'B': 1,
    'KB': 1024,
    'MB': 1024 * 1024,
    'GB': 1024 * 1024 * 1024,
    'TB': 1024 * 1024 * 1024 * 1024
  }

  return Math.round(num * (multipliers[unit.toUpperCase()] || 1))
}

/**
 * Check if file size exceeds limit
 */
export function exceedsLimit(bytes: number, limitMB: number): boolean {
  return bytes > limitMB * 1024 * 1024
}