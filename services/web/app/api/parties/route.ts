import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { normalizePartyName, normalizeTin, getAllActiveParties } from '@/lib/partyResolver';

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const countryCode = searchParams.get('country_code') || undefined;
    const search = searchParams.get('search');

    // Pagination parameters
    const DEFAULT_PAGE_SIZE = 50;
    const MAX_PAGE_SIZE = 100;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(
      parseInt(searchParams.get('limit') || String(DEFAULT_PAGE_SIZE)),
      MAX_PAGE_SIZE
    );
    const skip = (page - 1) * limit;

    // Build where clause
    const where: any = {
      deletedAt: null
    };

    if (search) {
      const normalized = normalizePartyName(search);
      // Search in both display name and TIN
      where.OR = [
        {
          nameNormalized: {
            contains: normalized
          }
        },
        {
          tinNormalized: {
            contains: normalizeTin(search)
          }
        }
      ];
    }

    if (countryCode) {
      where.countryCode = countryCode;
    }

    // Execute query with count for pagination
    const [parties, totalCount] = await Promise.all([
      prisma.party.findMany({
        where,
        select: {
          id: true,
          displayName: true,
          tinDisplay: true,
          countryCode: true,
          addressFull: true,
          email: true,
          buyerDocument: true,
          buyerDocumentNumber: true,
          buyerIdtku: true,
          createdAt: true,
          updatedAt: true
        },
        skip,
        take: limit,
        orderBy: {
          displayName: 'asc'
        }
      }),
      prisma.party.count({ where })
    ]);

    return NextResponse.json({
      parties,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasMore: skip + limit < totalCount
      }
    });
  } catch (error) {
    console.error('Error fetching parties:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch parties' } },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { displayName, tinDisplay, countryCode, addressFull, email, buyerDocument, buyerDocumentNumber, buyerIdtku, createdBy } = body;

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

    // Normalize for pre-checks (database will also normalize via trigger)
    const nameNormalized = normalizePartyName(displayName);
    const tinNormalized = normalizeTin(tinDisplay);

    // Validate TIN is not empty after normalization
    if (tinNormalized.length === 0) {
      return NextResponse.json(
        { error: { code: 'INVALID_TIN', message: 'TIN cannot be empty or contain only formatting characters' } },
        { status: 400 }
      );
    }

    // Check for existing party with same normalized name
    const existingByName = await prisma.party.findFirst({
      where: {
        nameNormalized,
        deletedAt: null
      },
      select: {
        id: true,
        displayName: true,
        tinDisplay: true,
        tinNormalized: true
      }
    });

    if (existingByName) {
      // Check if it's the same TIN (legitimate duplicate) or different TIN (collision)
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
      } else {
        // Same name + same TIN = duplicate entry
        return NextResponse.json(
          {
            error: {
              code: 'DUPLICATE_PARTY',
              message: `Party already exists`,
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

    // Check for existing party with same TIN in same country
    const existingByTin = await prisma.party.findFirst({
      where: {
        tinNormalized,
        countryCode: countryCode || null,
        deletedAt: null
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

    // Create party (database triggers will auto-normalize)
    const party = await prisma.party.create({
      data: {
        displayName,
        nameNormalized: '', // Will be auto-generated by trigger
        tinDisplay,
        tinNormalized: '',  // Will be auto-generated by trigger
        countryCode: countryCode || null,
        addressFull: addressFull || null,
        email: email || null,
        buyerDocument: buyerDocument || null, // Defaults to 'TIN' in DB
        buyerDocumentNumber: buyerDocumentNumber || null,
        buyerIdtku: buyerIdtku || null, // Will be auto-calculated if null
        createdBy: createdBy || null
      }
    });

    return NextResponse.json(party, { status: 201 });

  } catch (error: any) {
    console.error('Error creating party:', error);

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
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to create party' } },
      { status: 500 }
    );
  }
}
