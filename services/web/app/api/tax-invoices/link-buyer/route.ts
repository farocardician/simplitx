import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

type Snapshot = {
  id: string;
  buyer_party_id: string | null;
  buyer_name: string | null;
  buyer_tin: string | null;
  buyer_document: string | null;
  buyer_country: string | null;
  buyer_document_number: string | null;
  buyer_address: string | null;
  buyer_email: string | null;
  buyer_idtku: string | null;
  trx_code: string | null;
  missing_fields: string[] | null;
  is_complete: boolean | null;
};

function computeMissingFields(data: {
  buyer_party_id: string | null;
  trx_code: string | null;
  buyer_tin: string | null;
  buyer_document: string | null;
  buyer_country: string | null;
  buyer_address: string | null;
  buyer_idtku: string | null;
  buyer_name: string | null;
}) {
  const required = [
    'buyer_party_id',
    'trx_code',
    'buyer_tin',
    'buyer_document',
    'buyer_country',
    'buyer_address',
    'buyer_idtku'
  ];

  const missing = required.filter((field) => {
    const value = (data as Record<string, any>)[field];
    return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  });

  if (!data.buyer_name || data.buyer_name.trim() === '') {
    missing.push('buyer_name');
  }

  return missing;
}

async function applyLink(partyId: string, invoiceIds: string[]) {
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
    return { error: { code: 'PARTY_NOT_FOUND', message: 'Buyer party not found or inactive' }, status: 404 };
  }

  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    return { error: { code: 'INVALID_REQUEST', message: 'invoiceIds must be a non-empty array' }, status: 400 };
  }

  const invoices = await prisma.$queryRaw<Snapshot[]>`
    SELECT
      id,
      buyer_party_id,
      buyer_name,
      buyer_tin,
      buyer_document,
      buyer_country,
      buyer_document_number,
      buyer_address,
      buyer_email,
      buyer_idtku,
      trx_code,
      missing_fields,
      is_complete
    FROM tax_invoices
    WHERE id = ANY(${invoiceIds}::uuid[])
  `;

  if (invoices.length === 0) {
    return { error: { code: 'NOT_FOUND', message: 'No invoices found for provided ids' }, status: 404 };
  }

  const buyerDocument = party.buyerDocument ?? 'TIN';
  const displayName = party.displayName || party.nameNormalized;

  const updates = invoices.map((inv) => {
    const resolvedTrxCode = party.transactionCode ?? inv.trx_code ?? null;
    const buyerName = displayName;

    const missingFields = computeMissingFields({
      buyer_party_id: party.id,
      trx_code: resolvedTrxCode,
      buyer_tin: party.tinNormalized,
      buyer_document: buyerDocument,
      buyer_country: party.countryCode ?? null,
      buyer_address: party.addressFull ?? null,
      buyer_idtku: party.buyerIdtku ?? null,
      buyer_name: buyerName
    });

    return prisma.$executeRaw`
      UPDATE tax_invoices
      SET
        buyer_party_id = ${party.id}::uuid,
        buyer_name = ${buyerName},
        buyer_tin = ${party.tinNormalized},
        buyer_document = ${buyerDocument},
        buyer_country = ${party.countryCode},
        buyer_document_number = ${party.buyerDocumentNumber ?? null},
        buyer_address = ${party.addressFull},
        buyer_email = ${party.email},
        buyer_idtku = ${party.buyerIdtku},
        trx_code = ${resolvedTrxCode},
        missing_fields = ${JSON.stringify(missingFields)}::jsonb,
        is_complete = ${missingFields.length === 0},
        updated_at = NOW()
      WHERE id = ${inv.id}::uuid
    `;
  });

  await prisma.$transaction(updates);

  return {
    updated: invoices.length,
    partyName: displayName,
    undo: invoices
  };
}

async function undoLink(previous: Snapshot[]) {
  if (!Array.isArray(previous) || previous.length === 0) {
    return { error: { code: 'INVALID_REQUEST', message: 'previous snapshots required for undo' }, status: 400 };
  }

  const updates = previous.map((inv) => prisma.$executeRaw`
    UPDATE tax_invoices
    SET
      buyer_party_id = ${inv.buyer_party_id},
      buyer_name = ${inv.buyer_name},
      buyer_tin = ${inv.buyer_tin},
      buyer_document = ${inv.buyer_document},
      buyer_country = ${inv.buyer_country},
      buyer_document_number = ${inv.buyer_document_number},
      buyer_address = ${inv.buyer_address},
      buyer_email = ${inv.buyer_email},
      buyer_idtku = ${inv.buyer_idtku},
      trx_code = ${inv.trx_code},
      missing_fields = ${inv.missing_fields ? JSON.stringify(inv.missing_fields) : null}::jsonb,
      is_complete = ${inv.is_complete},
      updated_at = NOW()
    WHERE id = ${inv.id}::uuid
  `);

  await prisma.$transaction(updates);

  return { restored: previous.length };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action === 'undo' ? 'undo' : 'apply';

    if (action === 'undo') {
      const previous = body?.previous;
      const result = await undoLink(previous);
      if ('error' in result) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }
      return NextResponse.json({ restored: result.restored });
    }

    const partyId = typeof body?.partyId === 'string' ? body.partyId.trim() : '';
    const invoiceIds = Array.isArray(body?.invoiceIds) ? body.invoiceIds : [];

    if (!partyId || invoiceIds.length === 0) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'partyId and invoiceIds are required' } },
        { status: 400 }
      );
    }

    const result = await applyLink(partyId, invoiceIds);
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      updated: result.updated,
      partyName: result.partyName,
      undo: result.undo
    });
  } catch (error) {
    console.error('Failed to link buyer to invoices', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to link buyer to invoices' } },
      { status: 500 }
    );
  }
}
