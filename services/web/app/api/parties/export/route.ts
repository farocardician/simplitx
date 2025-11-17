import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { selectionToWhere } from '@/lib/server/partyAdmin';
import { PartySelectionPayload } from '@/types/party-admin';
import { exportPartiesToCsv, PartyWithSeller } from '@/lib/server/partyCsv';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const selection = body.selection as PartySelectionPayload | undefined;

    if (!selection) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Selection payload is required' } },
        { status: 400 }
      );
    }

    const where = selectionToWhere(selection);
    const parties = await prisma.party.findMany({
      where,
      select: {
        id: true,
        displayName: true,
        tinDisplay: true,
        countryCode: true,
        transactionCode: true,
        email: true,
        addressFull: true,
        buyerDocument: true,
        buyerDocumentNumber: true,
        buyerIdtku: true,
        partyType: true,
        sellerId: true,
        seller: {
          select: {
            id: true,
            displayName: true,
            tinDisplay: true
          }
        }
      },
      orderBy: {
        displayName: 'asc'
      }
    });

    if (parties.length === 0) {
      return NextResponse.json(
        { error: { code: 'NO_RESULTS', message: 'No parties match the selected filters' } },
        { status: 404 }
      );
    }

    const csv = exportPartiesToCsv(parties as PartyWithSeller[]);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="parties-export-${timestamp}.csv"`
      }
    });
  } catch (error) {
    console.error('Export failed:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to export parties' } },
      { status: 500 }
    );
  }
}
