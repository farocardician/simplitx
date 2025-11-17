import { NextRequest, NextResponse } from 'next/server';
import { PartyType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { normalizeTin, normalizePartyName } from '@/lib/partyResolver';
import { parsePartyCsv } from '@/lib/server/partyCsv';
import { parsePartyRoleParam } from '@/lib/server/partyAdmin';

/**
 * Normalize TIN/NPWP with support for:
 * - Modern 16-digit NPWP/NIK format
 * - Old 15-digit NPWP format (converts to new format by prepending "0")
 * - 14-digit and other formats (pad with leading zeros to 16 digits)
 * - Stripped leading zeros from Excel/Google Sheets
 */
function normalizeTinWithNpwpConversion(tinDisplay: string): string {
  // First, apply standard normalization (trim, uppercase, remove formatting)
  const normalized = normalizeTin(tinDisplay);

  // Get only the digits
  const digitsOnly = normalized.replace(/\D/g, '');

  // Handle length conversion
  if (digitsOnly.length >= 16) {
    // Already 16 digits or more - take first 16 digits
    return digitsOnly.substring(0, 16);
  } else if (digitsOnly.length > 0) {
    // Pad with leading zeros to reach 16 digits
    // This handles: 15-digit old NPWP, 14-digit formats, etc.
    return digitsOnly.padStart(16, '0');
  } else {
    // No digits found - return original normalized string
    // Will be caught by validation downstream
    return normalized;
  }
}

interface ImportSummary {
  created: number;
  updated: number;
  failed: number;
}

interface UpdateDetail {
  rowNumber: number;
  displayName: string;
  reason: string; // e.g., "Duplicate name found - updated existing party"
  existingPartyId: string;
  existingPartyName: string;
}

export async function POST(req: NextRequest) {
  const summary: ImportSummary = { created: 0, updated: 0, failed: 0 };
  const errors: Array<{ rowNumber: number; message: string }> = [];
  const updateDetails: UpdateDetail[] = [];

  // Outer try-catch to ensure we always return JSON
  try {
    console.log('[Import] Starting import request...');
    const formData = await req.formData();
    const file = formData.get('file');
    console.log('[Import] File received:', file instanceof File ? `${file.name} (${file.size} bytes)` : 'no file');

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'CSV file is required' } },
        { status: 400 }
      );
    }

    const content = await file.text();
    console.log('[Import] CSV content read:', content.length, 'characters');
    const parsed = parsePartyCsv(content);
    console.log('[Import] CSV parsed:', parsed.rows.length, 'rows found');

    const rows = [...parsed.rows].sort((a, b) => {
      const aType = a.data['party_type'].trim().toLowerCase();
      const bType = b.data['party_type'].trim().toLowerCase();
      if (aType === 'seller' && bType !== 'seller') return -1;
      if (aType !== 'seller' && bType === 'seller') return 1;
      return 0;
    });
    console.log('[Import] Rows sorted, sellers first');

    if (rows.length === 0) {
      return NextResponse.json(
        { error: { code: 'EMPTY_CSV', message: 'No data rows found in CSV' } },
        { status: 400 }
      );
    }

    // Track mapping of old IDs (from export) to new IDs (from database)
    const idMapping = new Map<string, string>();

    const partyIds = Array.from(
      new Set(
        rows
          .map(row => row.data['internal_party_id__do_not_edit'].trim())
          .filter(Boolean)
      )
    );
    console.log('[Import] Found', partyIds.length, 'unique party IDs to check');

    const sellerIds = Array.from(
      new Set(
        rows
          .map(row => row.data['seller_internal_party_id__do_not_edit'].trim())
          .filter(Boolean)
      )
    );
    console.log('[Import] Found', sellerIds.length, 'unique seller IDs to check');

    console.log('[Import] Fetching existing parties...');
    const existingParties = partyIds.length
      ? await prisma.party.findMany({
          where: {
            id: {
              in: partyIds
            }
          },
          select: {
            id: true,
            partyType: true,
            deletedAt: true
          }
        })
      : [];

    console.log('[Import] Found', existingParties.length, 'existing parties');
    const existingById = new Map(existingParties.map(p => [p.id, p]));

    console.log('[Import] Fetching sellers...');
    const sellers = sellerIds.length
      ? await prisma.party.findMany({
          where: {
            id: {
              in: sellerIds
            },
            deletedAt: null,
            partyType: 'seller'
          },
          select: {
            id: true
          }
        })
      : [];
    console.log('[Import] Found', sellers.length, 'active sellers');

    const sellersById = new Map(sellers.map(s => [s.id, s]));
    const activeSellers = new Map(sellers.map(s => [s.id, s]));

    // Pre-populate idMapping with existing parties
    for (const party of existingParties) {
      idMapping.set(party.id, party.id);
    }

    // Fetch valid transaction codes for validation
    const validTransactionCodes = await prisma.transactionCode.findMany({
      select: { code: true }
    });
    const validCodeSet = new Set(validTransactionCodes.map(tc => tc.code));

    console.log('[Import] Starting to process', rows.length, 'rows...');

    // Process each row with comprehensive error handling
    for (const row of rows) {
      const data = row.data;
      const rowNumber = row.rowNumber;

      try {
        // Early logging to track progress
        if (rowNumber % 50 === 0) {
          console.log(`Processing row ${rowNumber}...`);
        }

        const displayName = data['display_name'].trim();
        const tinDisplay = data['tin_display'].trim();
        const partyTypeValue = data['party_type'].trim().toLowerCase();
        const internalId = data['internal_party_id__do_not_edit'].trim();
        const sellerInternalId = data['seller_internal_party_id__do_not_edit'].trim();

        if (!displayName) {
          throw new Error('Display name is required');
        }
        if (!tinDisplay) {
          throw new Error('TIN is required');
        }

        const tinNormalized = normalizeTinWithNpwpConversion(tinDisplay);
        if (!tinNormalized) {
          throw new Error('TIN cannot be empty after normalization');
        }

        // Validate that TIN result is 16 digits
        const digitsOnly = tinNormalized.replace(/\D/g, '');
        if (digitsOnly.length !== 16) {
          throw new Error(`TIN must contain digits that can be normalized to 16 digits. Got "${tinDisplay}" (${digitsOnly.length} digits)`);
        }

        const parsedType = parsePartyRoleParam(partyTypeValue);
        if (!parsedType) {
          throw new Error(`Invalid party type "${partyTypeValue}" (expected seller or buyer)`);
        }

        const countryCodeRaw = data['country_code'].trim().toUpperCase();
        const countryCode =
          countryCodeRaw.length === 0
            ? null
            : countryCodeRaw.length === 3
              ? countryCodeRaw
              : null;

        if (countryCodeRaw && !countryCode) {
          throw new Error('Country code must be a 3-letter ISO code');
        }

        let sellerLink: string | null = null;
        if (parsedType === 'buyer' && sellerInternalId) {
          if (sellerInternalId === internalId && internalId) {
            throw new Error('Buyer cannot be linked to itself');
          }
          // Use idMapping to resolve seller reference (handles both existing and newly created sellers)
          const mappedSellerId = idMapping.get(sellerInternalId);
          const sellerRecord = mappedSellerId ? activeSellers.get(mappedSellerId) : null;
          if (!sellerRecord) {
            throw new Error(`Seller reference ${sellerInternalId} not found or not active`);
          }
          sellerLink = sellerRecord.id;
        } else if (parsedType === 'seller' && sellerInternalId) {
          throw new Error('Sellers cannot reference another seller');
        }

        // Smart buyer_idtku handling:
        // - If empty or in scientific notation → generate from TIN + "000000"
        // - If already a normal number → keep it
        const buyerIdtkuRaw = data['buyer_idtku'].trim();
        let buyerIdtku: string | null = null;

        if (!buyerIdtkuRaw) {
          // Empty - generate from TIN
          buyerIdtku = tinNormalized ? `${tinNormalized}000000` : null;
        } else if (/[eE]/.test(buyerIdtkuRaw)) {
          // Scientific notation - generate from TIN
          buyerIdtku = tinNormalized ? `${tinNormalized}000000` : null;
        } else {
          // Normal value - keep as is
          buyerIdtku = buyerIdtkuRaw;
        }

        // Validate and normalize transaction code
        const transactionCodeRaw = data['transaction_code'].trim();
        let transactionCode: string | null = null;

        if (transactionCodeRaw) {
          // Normalize to 2-digit format (pad with leading zero if needed)
          const normalized = transactionCodeRaw.padStart(2, '0');

          if (!validCodeSet.has(normalized)) {
            throw new Error(`Invalid transaction code "${transactionCodeRaw}". Must be one of: ${Array.from(validCodeSet).sort().join(', ')}`);
          }
          transactionCode = normalized;
        }

        const payload = {
          displayName,
          tinDisplay: tinNormalized, // Use normalized version (with leading zeros restored)
          countryCode,
          transactionCode,
          email: data['email'].trim() || null,
          addressFull: data['address_full'].trim() || null,
          buyerDocument: data['buyer_document'].trim() || null,
          buyerDocumentNumber: data['buyer_document_number'].trim() || null,
          buyerIdtku: buyerIdtku,
          partyType: parsedType as PartyType,
          sellerId: sellerLink
        };

        if (internalId) {
          const existing = existingById.get(internalId);
          if (existing && !existing.deletedAt) {
            // Party exists and is not deleted - UPDATE it
            const updated = await prisma.party.update({
              where: { id: internalId },
              data: payload
            });
            summary.updated += 1;
            updateDetails.push({
              rowNumber,
              displayName,
              reason: 'Party with same internal ID already exists - updated with new data',
              existingPartyId: internalId,
              existingPartyName: updated.displayName
            });
            if (parsedType === 'seller') {
              activeSellers.set(updated.id, { id: updated.id });
            }
          } else {
            // Party doesn't exist or is deleted - CREATE a new one
            // Map old ID to new ID for seller references
            try {
              const created = await prisma.party.create({
                data: {
                  ...payload,
                  nameNormalized: '',
                  tinNormalized: '',
                  sellerId: payload.sellerId
                }
              });
              summary.created += 1;
              // Track old ID -> new ID mapping
              if (internalId) {
                idMapping.set(internalId, created.id);
              }
              if (parsedType === 'seller') {
                activeSellers.set(created.id, { id: created.id });
              }
            } catch (createError: any) {
              // Handle unique constraint violations
              if (createError?.code === 'P2002') {
                const target = createError?.meta?.target;

                // Try to find and update by normalized name
                if (!target || target?.includes('name_normalized')) {
                  const nameNorm = normalizePartyName(displayName);
                  const existingByName = await prisma.party.findFirst({
                    where: { nameNormalized: nameNorm, deletedAt: null }
                  });
                  if (existingByName) {
                    // Update existing party instead
                    await prisma.party.update({
                      where: { id: existingByName.id },
                      data: payload
                    });
                    summary.updated += 1;
                    updateDetails.push({
                      rowNumber,
                      displayName,
                      reason: `Duplicate party name found - merged with existing party "${existingByName.displayName}"`,
                      existingPartyId: existingByName.id,
                      existingPartyName: existingByName.displayName
                    });
                    if (internalId) {
                      idMapping.set(internalId, existingByName.id);
                    }
                    if (parsedType === 'seller') {
                      activeSellers.set(existingByName.id, { id: existingByName.id });
                    }
                    continue;
                  }
                }

                // Try to find and update by tin_normalized
                if (!target || target?.includes('tin_normalized')) {
                  const existingByTin = await prisma.party.findFirst({
                    where: { tinNormalized: tinNormalized, deletedAt: null }
                  });
                  if (existingByTin) {
                    // Update existing party instead
                    await prisma.party.update({
                      where: { id: existingByTin.id },
                      data: payload
                    });
                    summary.updated += 1;
                    updateDetails.push({
                      rowNumber,
                      displayName,
                      reason: `Duplicate TIN found (${tinDisplay}) - merged with existing party "${existingByTin.displayName}"`,
                      existingPartyId: existingByTin.id,
                      existingPartyName: existingByTin.displayName
                    });
                    if (internalId) {
                      idMapping.set(internalId, existingByTin.id);
                    }
                    if (parsedType === 'seller') {
                      activeSellers.set(existingByTin.id, { id: existingByTin.id });
                    }
                    continue;
                  }
                }
              }

              throw createError;
            }
          }
        } else {
          try {
            const created = await prisma.party.create({
              data: {
                ...payload,
                nameNormalized: '',
                tinNormalized: '',
                sellerId: payload.sellerId
              }
            });
            summary.created += 1;
            if (parsedType === 'seller') {
              activeSellers.set(created.id, { id: created.id });
            }
          } catch (createError: any) {
            // Handle unique constraint violations
            if (createError?.code === 'P2002') {
              const target = createError?.meta?.target;

              // Try to find and update by normalized name
              if (!target || target?.includes('name_normalized')) {
                const nameNorm = normalizePartyName(displayName);
                const existingByName = await prisma.party.findFirst({
                  where: { nameNormalized: nameNorm, deletedAt: null }
                });
                if (existingByName) {
                  // Update existing party instead
                  await prisma.party.update({
                    where: { id: existingByName.id },
                    data: payload
                  });
                  summary.updated += 1;
                  updateDetails.push({
                    rowNumber,
                    displayName,
                    reason: `Duplicate party name found - merged with existing party "${existingByName.displayName}"`,
                    existingPartyId: existingByName.id,
                    existingPartyName: existingByName.displayName
                  });
                  if (parsedType === 'seller') {
                    activeSellers.set(existingByName.id, { id: existingByName.id });
                  }
                  continue;
                }
              }

              // Try to find and update by tin_normalized
              if (!target || target?.includes('tin_normalized')) {
                const existingByTin = await prisma.party.findFirst({
                  where: { tinNormalized: tinNormalized, deletedAt: null }
                });
                if (existingByTin) {
                  // Update existing party instead
                  await prisma.party.update({
                    where: { id: existingByTin.id },
                    data: payload
                  });
                  summary.updated += 1;
                  updateDetails.push({
                    rowNumber,
                    displayName,
                    reason: `Duplicate TIN found (${tinDisplay}) - merged with existing party "${existingByTin.displayName}"`,
                    existingPartyId: existingByTin.id,
                    existingPartyName: existingByTin.displayName
                  });
                  if (parsedType === 'seller') {
                    activeSellers.set(existingByTin.id, { id: existingByTin.id });
                  }
                  continue;
                }
              }
            }

            throw createError;
          }
        }
      } catch (error: any) {
        summary.failed += 1;
        let errorMsg = error?.message || 'Unknown error';

        // Improve P2002 constraint error messages
        if (error?.code === 'P2002') {
          const target = error?.meta?.target;
          if (target && Array.isArray(target)) {
            errorMsg = `Duplicate value: A party with this ${target.join('/')} already exists`;
          }
        }

        console.error(`[Import] Row ${rowNumber} error:`, errorMsg);
        errors.push({
          rowNumber,
          message: errorMsg
        });
      }
    }

    console.log('[Import] Processing complete. Summary:', summary);

    return NextResponse.json({
      summary,
      errors,
      updateDetails
    });
  } catch (error: any) {
    console.error('Import failed with error:', {
      message: error?.message,
      code: error?.code,
      stack: error?.stack,
      processed: summary
    });

    // Always return what we've processed so far along with the error
    return NextResponse.json({
      summary,
      errors,
      updateDetails,
      error: {
        code: 'PARTIAL_IMPORT_ERROR',
        message: error?.message || 'Import failed after processing some records'
      }
    });
  }
}
