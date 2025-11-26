import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

type Snapshot = {
  id: string;
  invoice_number: string;
  ref_desc?: string | null;
  buyer_party_id?: string | null;
};

function normalizeInvoiceNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const invoiceId = typeof body?.invoiceId === 'string' ? body.invoiceId.trim() : '';
    const invoiceNumber = normalizeInvoiceNumber(body?.invoiceNumber);

    if (!invoiceId || !invoiceNumber) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'invoiceId and invoiceNumber are required' } },
        { status: 400 }
      );
    }

    const current = await prisma.$queryRaw<Snapshot[]>`
      SELECT id, invoice_number, ref_desc, buyer_party_id
      FROM tax_invoices
      WHERE id = ${invoiceId}::uuid
      LIMIT 1
    `;

    if (current.length === 0) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Invoice not found' } },
        { status: 404 }
      );
    }

    const row: any = current[0];
    const buyerPartyId: string | null = row.buyer_party_id ?? null;

    const duplicate = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM tax_invoices
      WHERE invoice_number = ${invoiceNumber}
        AND buyer_party_id IS NOT DISTINCT FROM ${buyerPartyId}
        AND id <> ${invoiceId}::uuid
      LIMIT 1
    `;

    if (duplicate.length > 0) {
      return NextResponse.json(
        { error: { code: 'DUPLICATE_INVOICE', message: 'Another invoice with this number already exists for the same buyer' } },
        { status: 400 }
      );
    }

    await prisma.$executeRaw`
      UPDATE tax_invoices
      SET invoice_number = ${invoiceNumber},
          ref_desc = ${invoiceNumber},
          updated_at = NOW()
      WHERE id = ${invoiceId}::uuid
    `;

    return NextResponse.json({
      updated: 1,
      previous: {
        invoiceId,
        invoiceNumber: row.invoice_number
      }
    });
  } catch (error) {
    console.error('Failed to update invoice number', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to update invoice number' } },
      { status: 500 }
    );
  }
}
