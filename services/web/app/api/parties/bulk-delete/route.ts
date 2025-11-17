import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { selectionToWhere } from '@/lib/server/partyAdmin';
import { PartySelectionPayload } from '@/types/party-admin';

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
    const result = await prisma.party.updateMany({
      where,
      data: {
        deletedAt: new Date()
      }
    });

    return NextResponse.json({
      success: true,
      deleted: result.count
    });
  } catch (error) {
    console.error('Bulk delete failed:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to delete parties' } },
      { status: 500 }
    );
  }
}
