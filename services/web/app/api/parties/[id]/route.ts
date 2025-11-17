import { NextRequest, NextResponse } from 'next/server';
import { PartyType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { normalizePartyName, normalizeTin } from '@/lib/partyResolver';
import { parsePartyRoleParam } from '@/lib/server/partyAdmin';

interface RouteContext {
  params: {
    id: string;
  };
}

export async function PUT(
  req: NextRequest,
  context: RouteContext
) {
  try {
    const partyId = context.params.id;
    const body = await req.json();
    const {
      displayName,
      tinDisplay,
      countryCode,
      addressFull,
      email,
      buyerDocument,
      buyerDocumentNumber,
      buyerIdtku,
      updatedBy,
      transactionCode,
      updatedAt: clientUpdatedAt, // For optimistic concurrency
      partyType: rawPartyType,
      sellerId: rawSellerId
    } = body;

    // Validate required fields
    if (!displayName || !tinDisplay) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'displayName and tinDisplay are required' } },
        { status: 400 }
      );
    }

    // Length validation
    if (displayName.length > 255) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Display name too long (max 255 characters)' } },
        { status: 400 }
      );
    }

    if (tinDisplay.length > 50) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'TIN too long (max 50 characters)' } },
        { status: 400 }
      );
    }

    if (addressFull && addressFull.length > 1000) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Address too long (max 1000 characters)' } },
        { status: 400 }
      );
    }

    if (email && email.length > 255) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Email too long (max 255 characters)' } },
        { status: 400 }
      );
    }

    // Validate country code format
    if (countryCode && (countryCode.length !== 3 || countryCode !== countryCode.toUpperCase() || !/^[A-Z]{3}$/.test(countryCode))) {
      return NextResponse.json(
        { error: { code: 'INVALID_COUNTRY_CODE', message: 'Country code must be 3-letter uppercase ISO code (e.g., USA, BRA, IDN)' } },
        { status: 400 }
      );
    }

    // Validate TIN is not empty after normalization
    const tinNormalized = normalizeTin(tinDisplay);
    if (tinNormalized.length === 0) {
      return NextResponse.json(
        { error: { code: 'INVALID_TIN', message: 'TIN cannot be empty or contain only formatting characters' } },
        { status: 400 }
      );
    }

    // Normalize for pre-checks
    const nameNormalized = normalizePartyName(displayName);

    // Check if party exists and hasn't been modified
    const existingParty = await prisma.party.findUnique({
      where: { id: partyId },
      select: {
        id: true,
        displayName: true,
        nameNormalized: true,
        tinNormalized: true,
        countryCode: true,
        updatedAt: true,
        deletedAt: true,
        partyType: true,
        sellerId: true
      }
    });

    if (!existingParty) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Party not found' } },
        { status: 404 }
      );
    }

    if (existingParty.deletedAt) {
      return NextResponse.json(
        { error: { code: 'DELETED', message: 'Cannot update deleted party' } },
        { status: 410 }
      );
    }

    // Optimistic concurrency check
    if (clientUpdatedAt) {
      const clientDate = new Date(clientUpdatedAt);
      const serverDate = new Date(existingParty.updatedAt);

      if (serverDate.getTime() !== clientDate.getTime()) {
        return NextResponse.json(
          {
            error: {
              code: 'CONFLICT',
              message: 'Party was modified by another user. Please refresh and try again.',
              serverUpdatedAt: existingParty.updatedAt
            }
          },
          { status: 409 }
        );
      }
    }

    // Check for name collision with other parties (if name changed)
    if (nameNormalized !== existingParty.nameNormalized) {
      const existingByName = await prisma.party.findFirst({
        where: {
          nameNormalized,
          deletedAt: null,
          id: { not: partyId }
        },
        select: {
          id: true,
          displayName: true,
          tinDisplay: true,
          tinNormalized: true
        }
      });

      if (existingByName) {
        // Check if it's the same TIN (legitimate) or different TIN (collision)
        if (existingByName.tinNormalized !== tinNormalized) {
          return NextResponse.json(
            {
              error: {
                code: 'NAME_COLLISION',
                message: `Party name "${displayName}" already exists with different TIN`,
                existing: {
                  id: existingByName.id,
                  displayName: existingByName.displayName,
                  tinDisplay: existingByName.tinDisplay
                }
              }
            },
            { status: 409 }
          );
        }
      }
    }

    // Check for TIN collision in same country (if TIN or country changed)
    if (tinNormalized !== existingParty.tinNormalized ||
        (countryCode || null) !== existingParty.countryCode) {
      const existingByTin = await prisma.party.findFirst({
        where: {
          tinNormalized,
          countryCode: countryCode || null,
          deletedAt: null,
          id: { not: partyId }
        },
        select: {
          id: true,
          displayName: true,
          tinDisplay: true
        }
      });

      if (existingByTin) {
        return NextResponse.json(
          {
            error: {
              code: 'DUPLICATE_TIN',
              message: `TIN "${tinDisplay}" already registered${countryCode ? ` in ${countryCode}` : ''}`,
              existing: {
                id: existingByTin.id,
                displayName: existingByTin.displayName,
                tinDisplay: existingByTin.tinDisplay
              }
            }
          },
          { status: 409 }
        );
      }
    }

    // Handle seller link for partyType and sellerId changes
    let resolvedPartyType: PartyType = existingParty.partyType;
    if (typeof rawPartyType === 'string') {
      const parsed = parsePartyRoleParam(rawPartyType);
      if (parsed) {
        resolvedPartyType = parsed as PartyType;
      }
    }

    let sellerLink: string | null = resolvedPartyType === 'buyer' ? existingParty.sellerId : null;
    const normalizedSellerId = typeof rawSellerId === 'string' ? rawSellerId.trim() : '';

    if (resolvedPartyType === 'buyer') {
      if (rawSellerId === null || normalizedSellerId === '') {
        sellerLink = null;
      }

      if (normalizedSellerId) {
        if (normalizedSellerId === partyId) {
          return NextResponse.json(
            { error: { code: 'INVALID_SELLER_LINK', message: 'Buyer cannot be linked to itself' } },
            { status: 400 }
          );
        }

        const seller = await prisma.party.findFirst({
          where: {
            id: normalizedSellerId,
            deletedAt: null,
            partyType: 'seller'
          },
          select: {
            id: true
          }
        });

        if (!seller) {
          return NextResponse.json(
            { error: { code: 'INVALID_SELLER', message: 'Linked seller not found or inactive' } },
            { status: 400 }
          );
        }

        sellerLink = seller.id;
      }
    } else if (normalizedSellerId || rawSellerId === null) {
      // Sellers cannot keep seller references
      sellerLink = null;
      if (normalizedSellerId) {
        return NextResponse.json(
          { error: { code: 'INVALID_REQUEST', message: 'Sellers cannot reference another seller' } },
          { status: 400 }
        );
      }
    }

    // Update party (database triggers will auto-normalize)
    const updatedParty = await prisma.party.update({
      where: { id: partyId },
      data: {
        displayName,
        tinDisplay,
        countryCode: countryCode || null,
        addressFull: addressFull || null,
        transactionCode: transactionCode !== undefined ? (transactionCode || null) : undefined,
        email: email || null,
        buyerDocument: buyerDocument !== undefined ? buyerDocument : undefined,
        buyerDocumentNumber: buyerDocumentNumber !== undefined ? buyerDocumentNumber : undefined,
        buyerIdtku: buyerIdtku !== undefined ? buyerIdtku : undefined,
        sellerId: sellerLink,
        partyType: resolvedPartyType,
        updatedBy: updatedBy || null
      }
    });

    return NextResponse.json(updatedParty);

  } catch (error: any) {
    console.error('Error updating party:', error);

    // Handle database constraint violations
    if (error.code === 'P2002') {
      return NextResponse.json(
        { error: { code: 'UNIQUENESS_VIOLATION', message: 'Party name or TIN already exists' } },
        { status: 409 }
      );
    }

    // Handle custom database errors (from triggers)
    if (error.code === '23505') {
      return NextResponse.json(
        { error: { code: 'COLLISION_DETECTED', message: error.message } },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to update party' } },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  context: RouteContext
) {
  try {
    const partyId = context.params.id;

    // Check if party exists
    const existingParty = await prisma.party.findUnique({
      where: { id: partyId },
      select: {
        id: true,
        displayName: true,
        deletedAt: true
      }
    });

    if (!existingParty) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Party not found' } },
        { status: 404 }
      );
    }

    if (existingParty.deletedAt) {
      return NextResponse.json(
        { error: { code: 'ALREADY_DELETED', message: 'Party already deleted' } },
        { status: 410 }
      );
    }

    // Soft delete by setting deletedAt
    const deletedParty = await prisma.party.update({
      where: { id: partyId },
      data: {
        deletedAt: new Date()
      }
    });

    return NextResponse.json({
      success: true,
      message: `Party "${existingParty.displayName}" deleted`,
      party: deletedParty
    });

  } catch (error: any) {
    console.error('Error deleting party:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to delete party' } },
      { status: 500 }
    );
  }
}

// PATCH endpoint for undo delete (restore)
export async function PATCH(
  req: NextRequest,
  context: RouteContext
) {
  try {
    const partyId = context.params.id;
    const body = await req.json();
    const { action } = body;

    if (action === 'restore') {
      // Check if party exists and is deleted
      const existingParty = await prisma.party.findUnique({
        where: { id: partyId },
        select: {
          id: true,
          displayName: true,
          nameNormalized: true,
          tinNormalized: true,
          countryCode: true,
          deletedAt: true
        }
      });

      if (!existingParty) {
        return NextResponse.json(
          { error: { code: 'NOT_FOUND', message: 'Party not found' } },
          { status: 404 }
        );
      }

      if (!existingParty.deletedAt) {
        return NextResponse.json(
          { error: { code: 'NOT_DELETED', message: 'Party is not deleted' } },
          { status: 400 }
        );
      }

      // Check if restoring would violate uniqueness constraints
      const nameConflict = await prisma.party.findFirst({
        where: {
          nameNormalized: existingParty.nameNormalized,
          deletedAt: null,
          id: { not: partyId }
        }
      });

      if (nameConflict) {
        return NextResponse.json(
          {
            error: {
              code: 'RESTORE_CONFLICT',
              message: 'Cannot restore: Another party with this name already exists',
              conflicting: {
                id: nameConflict.id,
                displayName: (nameConflict as any).displayName
              }
            }
          },
          { status: 409 }
        );
      }

      const tinConflict = await prisma.party.findFirst({
        where: {
          tinNormalized: existingParty.tinNormalized,
          countryCode: existingParty.countryCode,
          deletedAt: null,
          id: { not: partyId }
        }
      });

      if (tinConflict) {
        return NextResponse.json(
          {
            error: {
              code: 'RESTORE_CONFLICT',
              message: 'Cannot restore: Another party with this TIN already exists',
              conflicting: {
                id: tinConflict.id,
                displayName: (tinConflict as any).displayName
              }
            }
          },
          { status: 409 }
        );
      }

      // Restore by clearing deletedAt
      const restoredParty = await prisma.party.update({
        where: { id: partyId },
        data: {
          deletedAt: null
        }
      });

      return NextResponse.json({
        success: true,
        message: `Party "${existingParty.displayName}" restored`,
        party: restoredParty
      });
    }

    return NextResponse.json(
      { error: { code: 'INVALID_ACTION', message: 'Invalid action. Use "restore" to undo delete.' } },
      { status: 400 }
    );

  } catch (error: any) {
    console.error('Error in PATCH:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to process request' } },
      { status: 500 }
    );
  }
}
