export type PartyRole = 'seller' | 'buyer';

export interface PartyFilters {
  search?: string;
  countryCode?: string;
  partyType?: PartyRole;
  sellerId?: string;
  sellerName?: string;
}

export interface PartySelectionPayload {
  mode: 'ids' | 'filters';
  ids?: string[];
  filters?: PartyFilters;
  excludeIds?: string[];
}

export function isPartyRole(value: unknown): value is PartyRole {
  return value === 'seller' || value === 'buyer';
}
