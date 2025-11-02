export interface UomOption {
  code: string;
  name: string;
}

export const DEFAULT_JASA_UOM_CODE = 'UM.0030';

export function normalizeUomPayload(payload: unknown): UomOption[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map(item => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const candidate = item as { code?: unknown; name?: unknown };
      if (typeof candidate.code !== 'string' || typeof candidate.name !== 'string') {
        return null;
      }

      return { code: candidate.code, name: candidate.name };
    })
    .filter((item): item is UomOption => item !== null);
}

export function formatUomLabel(option: UomOption): string {
  return option.name;
}
