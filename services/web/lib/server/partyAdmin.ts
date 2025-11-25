import { Prisma } from '@prisma/client';
import { normalizePartyName, normalizeTin } from '@/lib/partyResolver';
import { PartyFilters, PartySelectionPayload, PartyRole, isPartyRole } from '@/types/party-admin';

export function parsePartyRoleParam(value: string | null): PartyRole | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  return isPartyRole(normalized) ? normalized : undefined;
}

export function buildPartyWhere(filters: PartyFilters = {}): Prisma.PartyWhereInput {
  const where: Prisma.PartyWhereInput = {
    deletedAt: null
  };

  const andClauses: Prisma.PartyWhereInput[] = [];

  // If filtering by specific party ID, return early with exact match
  if (filters.partyId) {
    return {
      deletedAt: null,
      id: filters.partyId
    };
  }

  if (filters.partyType) {
    where.partyType = filters.partyType;
  }

  if (filters.countryCode) {
    where.countryCode = filters.countryCode;
  }

  if (filters.sellerId) {
    where.sellerId = filters.sellerId;
    // Ensure we're only looking at buyers when filtering by seller
    if (!filters.partyType) {
      where.partyType = 'buyer';
    }
  }

  if (filters.sellerName) {
    const sellerNormalized = normalizePartyName(filters.sellerName);
    andClauses.push({
      seller: {
        nameNormalized: {
          contains: sellerNormalized
        }
      }
    });
    if (!filters.partyType) {
      where.partyType = 'buyer';
    }
  }

  if (filters.search && filters.search.trim().length >= 2) {
    const normalizedName = normalizePartyName(filters.search);
    andClauses.push({
      OR: [
        {
          nameNormalized: {
            contains: normalizedName
          }
        },
        {
          tinNormalized: {
            contains: normalizeTin(filters.search)
          }
        }
      ]
    });
  }

  if (andClauses.length > 0) {
    where.AND = [...(where.AND || []), ...andClauses];
  }

  return where;
}

export function selectionToWhere(
  selection: PartySelectionPayload,
  fallbackFilters?: PartyFilters
): Prisma.PartyWhereInput {
  if (selection.mode === 'ids') {
    if (!selection.ids || selection.ids.length === 0) {
      throw new Error('No parties selected');
    }
    return {
      deletedAt: null,
      id: {
        in: selection.ids
      }
    };
  }

  const filters = selection.filters || fallbackFilters || {};
  const where = buildPartyWhere(filters);

  if (selection.excludeIds && selection.excludeIds.length > 0) {
    where.AND = [
      ...(where.AND || []),
      {
        id: {
          notIn: selection.excludeIds
        }
      }
    ];
  }

  return where;
}
