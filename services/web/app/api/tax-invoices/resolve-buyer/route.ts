import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { normalizePartyName } from '@/lib/partyResolver';

type InvoiceRow = {
  id: string;
};

function computeMissingFields(data: {
  buyer_party_id: string | null;
  trx_code: string | null;
  buyer_tin: string | null;
  buyer_document: string | null;
  buyer_country: string | null;
  buyer_address: string | null;
  buyer_idtku: string | null;
}): string[] {
  const required = [
    'buyer_party_id',
    'trx_code',
    'buyer_tin',
    'buyer_document',
    'buyer_country',
    'buyer_address',
    'buyer_idtku'
  ];

  return required.filter((field) => {
    const value = (data as Record<string, any>)[field];
    return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const buyerName = typeof body?.buyerName === 'string' ? body.buyerName.trim() : '';
    const partyId = typeof body?.partyId === 'string' ? body.partyId.trim() : '';

    if (!buyerName || !partyId) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'buyerName and partyId are required' } },
        { status: 400 }
      );
    }

    const party = await prisma.party.findFirst({
      where: { id: partyId, deletedAt: null, partyType: 'buyer' },
      select: {
        id: true,
        displayName: true,
        nameNormalized: true,
        tinNormalized: true,
        countryCode: true,
        addressFull: true,
        email: true,
        buyerDocument: true,
        buyerDocumentNumber: true,
        buyerIdtku: true,
        transactionCode: true
      }
    });

    if (!party) {
      return NextResponse.json(
        { error: { code: 'PARTY_NOT_FOUND', message: 'Buyer party not found or inactive' } },
        { status: 404 }
      );
    }

    const normalizedBuyerName = normalizePartyName(buyerName);
    const invoices = await prisma.$queryRaw<InvoiceRow[]>(
      Prisma.sql`
        SELECT DISTINCT ti.id
        FROM tax_invoices ti
        JOIN public."temporaryStaging" ts
          ON ts.invoice = ti.invoice_number AND ts.job_id = ti.job_id
        WHERE ti.buyer_party_id IS NULL
          AND ts.buyer_name_raw IS NOT NULL
          AND normalize_party_name(ts.buyer_name_raw) = ${normalizedBuyerName}
      `
    );

    if (!invoices.length) {
      return NextResponse.json({
        updated: 0,
        message: 'No invoices matched buyer name'
      });
    }

    const buyerNameForDisplay = party.nameNormalized || party.displayName;
    const buyerDocument = party.buyerDocument ?? 'TIN';

    const updates = invoices.map((invoice) => {
      const resolvedTrxCode = party.transactionCode ?? null;
      const missingFields = computeMissingFields({
        buyer_party_id: party.id,
        trx_code: resolvedTrxCode,
        buyer_tin: party.tinNormalized,
        buyer_document: buyerDocument,
        buyer_country: party.countryCode ?? null,
        buyer_address: party.addressFull ?? null,
        buyer_idtku: party.buyerIdtku ?? null
      });

      return prisma.$executeRaw(
        Prisma.sql`
          UPDATE tax_invoices
          SET
            buyer_party_id = ${party.id}::uuid,
            missing_fields = ${JSON.stringify(missingFields)}::jsonb,
            is_complete = ${missingFields.length === 0},
            updated_at = NOW()
          WHERE id = ${invoice.id}::uuid
        `
      );
    });

    await prisma.$transaction(updates);

    return NextResponse.json({
      updated: invoices.length,
      buyerName: buyerNameForDisplay,
      normalizedBuyerName
    });
  } catch (error) {
    console.error('Failed to resolve invoices for buyer', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve buyer on invoices' } },
      { status: 500 }
    );
  }
}
