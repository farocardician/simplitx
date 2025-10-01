import { NextRequest, NextResponse } from 'next/server';
import { resolvePartyByName } from '@/lib/partyResolver';

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const name = searchParams.get('name');

    if (!name) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'name parameter is required' } },
        { status: 400 }
      );
    }

    const party = await resolvePartyByName(name);

    if (!party) {
      return NextResponse.json(
        {
          error: {
            code: 'NOT_FOUND',
            message: `Party name "${name}" not found`,
            suggestion: 'Use POST /api/parties to register new party'
          }
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      input: name,
      resolved: {
        tin: party.tin,
        tinDisplay: party.tinDisplay,
        countryCode: party.countryCode
      }
    });

  } catch (error) {
    console.error('Error resolving party:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve party' } },
      { status: 500 }
    );
  }
}
