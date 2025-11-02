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

export interface HsCodeSuggestion {
  id: string;
  code: string;
  type: HsType;
  level: string;
  descriptionEn: string;
  descriptionId: string;
}

export function normalizeHsCodeSuggestions(payload: unknown): HsCodeSuggestion[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map(item => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const candidate = item as {
        id?: unknown;
        code?: unknown;
        type?: unknown;
        level?: unknown;
        descriptionEn?: unknown;
        descriptionId?: unknown;
      };

      const id = typeof candidate.id === 'string' ? candidate.id : null;
      const code = typeof candidate.code === 'string' ? candidate.code : null;
      if (!id || !code) {
        return null;
      }

      const typeRaw = typeof candidate.type === 'string' ? candidate.type.toUpperCase() : null;
      const type: HsType = typeRaw === 'JASA' ? 'JASA' : 'BARANG';
      const level = typeof candidate.level === 'string' ? candidate.level : inferLevel(code) ?? 'HS6';
      const descriptionEn = typeof candidate.descriptionEn === 'string' ? candidate.descriptionEn : '';
      const descriptionId = typeof candidate.descriptionId === 'string' ? candidate.descriptionId : '';

      return {
        id,
        code,
        type,
        level,
        descriptionEn,
        descriptionId
      } satisfies HsCodeSuggestion;
    })
    .filter((item): item is HsCodeSuggestion => item !== null);
}

export function normalizeHsCodeSearchPayload(payload: unknown): HsCodeSuggestion[] {
  if (payload && typeof payload === 'object' && payload !== null) {
    const items = (payload as { items?: unknown }).items;
    if (Array.isArray(items)) {
      return normalizeHsCodeSuggestions(items);
    }
  }
  return normalizeHsCodeSuggestions(payload);
}

export function normalizeHsType(value: string | null | undefined): HsType | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === 'BARANG' || normalized === 'JASA') {
    return normalized as HsType;
  }
  return null;
}

export function formatHsTypeLabel(value: string | null | undefined): string {
  if (!value) return '';
  const normalized = value.toString().trim().toUpperCase();
  if (normalized === 'BARANG') return 'Barang';
  if (normalized === 'JASA') return 'Jasa';
  return value.toString();
}


export async function fetchHsCodeSuggestions(
  query: string,
  type: string | null | undefined,
  limit = 10
): Promise<HsCodeSuggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return [];
  }

  const params = new URLSearchParams();
  params.set('search', trimmed);
  params.set('limit', String(Math.max(1, limit)));

  const normalizedType = normalizeHsType(type);
  if (normalizedType) {
    params.set('type', normalizedType);
  }

  const response = await fetch(`/api/hs-codes?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to search HS codes');
  }

  const data = await response.json();
  return normalizeHsCodeSearchPayload(data);
}
