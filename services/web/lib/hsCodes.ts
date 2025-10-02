export type HsStatusFilter = 'active' | 'expired' | 'all';
export type HsLevel = 'HS2' | 'HS4' | 'HS6';

export function normalizeHsCode(raw: string): string {
  return raw.replace(/\s+/g, '').trim();
}

export function isValidHsCode(code: string): boolean {
  return /^[0-9]{2}([0-9]{2}){0,2}$/.test(code);
}

export function inferLevel(code: string): HsLevel | null {
  if (!isValidHsCode(code)) return null;
  if (code.length === 2) return 'HS2';
  if (code.length === 4) return 'HS4';
  if (code.length === 6) return 'HS6';
  return null;
}

export function expectedParent(code: string, level: HsLevel): string | null {
  if (level === 'HS2') return null;
  if (level === 'HS4') return code.substring(0, 2);
  if (level === 'HS6') return code.substring(0, 4);
  return null;
}

export function describeLevel(level: HsLevel): string {
  if (level === 'HS2') return 'HS2';
  if (level === 'HS4') return 'HS4';
  return 'HS6';
}

export function isDigitsOnlySearch(query: string): boolean {
  return /^[0-9]+$/.test(query.trim());
}

export function computeStatus(validFrom: Date | null, validTo: Date | null, now: Date = new Date()): 'active' | 'expired' {
  if (validTo && validTo < now) return 'expired';
  if (validFrom && validFrom > now) return 'expired';
  return 'active';
}
