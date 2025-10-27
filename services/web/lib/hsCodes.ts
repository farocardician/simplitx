export type HsLevel = 'HS2' | 'HS4' | 'HS6';
export type HsType = 'BARANG' | 'JASA';

export type HsStatusFilter = 'active' | 'expired' | 'all';

export function normalizeHsCode(raw: string): string {
  return raw.replace(/\D/g, '').trim();
}

export function isValidHsCode(code: string): boolean {
  const digits = normalizeHsCode(code);
  return digits.length === 2 || digits.length === 4 || digits.length === 6;
}

export function padHsCodeToSix(raw: string): string {
  const digits = normalizeHsCode(raw);
  if (!digits) return '';
  if (digits.length >= 6) return digits.slice(0, 6);
  return digits.padEnd(6, '0');
}

export function inferLevel(code: string): HsLevel | null {
  const padded = padHsCodeToSix(code);
  if (padded.length !== 6) return null;
  if (padded.slice(2) === '0000') return 'HS2';
  if (padded.slice(4) === '00') return 'HS4';
  return 'HS6';
}

export function expectedParent(code: string): string | null {
  const padded = padHsCodeToSix(code);
  const level = inferLevel(padded);
  if (!level) return null;
  if (level === 'HS2') return null;
  if (level === 'HS4') return `${padded.slice(0, 2)}0000`;
  return `${padded.slice(0, 4)}00`;
}

export function describeLevel(level: HsLevel): string {
  if (level === 'HS2') return 'HS2';
  if (level === 'HS4') return 'HS4';
  return 'HS6';
}

export function splitHsSegments(code: string): { section: string; chapter: string; group: string } {
  const padded = padHsCodeToSix(code);
  return {
    section: padded.slice(0, 2),
    chapter: padded.slice(2, 4),
    group: padded.slice(4, 6)
  };
}

export function isDigitsOnlySearch(query: string): boolean {
  return /^[0-9]+$/.test(query.trim());
}

export function computeStatus(validFrom: Date | null, validTo: Date | null, now: Date = new Date()): 'active' | 'expired' {
  if (validTo && validTo < now) return 'expired';
  if (validFrom && validFrom > now) return 'expired';
  return 'active';
}
