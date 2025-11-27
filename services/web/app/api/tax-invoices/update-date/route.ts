import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';

type Snapshot = {
  id: string;
  tax_invoice_date: string | null;
};

function parseDate(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function applyUpdate(invoiceIds: string[], invoiceDate: string) {
  const parsedDate = parseDate(invoiceDate);
  if (!parsedDate) {
    return { error: { code: 'INVALID_DATE', message: 'Invalid date format (expected YYYY-MM-DD)' }, status: 400 };
  }

  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    return { error: { code: 'INVALID_REQUEST', message: 'invoiceIds must be a non-empty array' }, status: 400 };
  }

  const snapshots = await prisma.$queryRaw<Snapshot[]>(
    Prisma.sql`
      SELECT id, tax_invoice_date
      FROM tax_invoices
      WHERE id = ANY(${invoiceIds}::uuid[])
    `
  );

  if (snapshots.length === 0) {
    return { error: { code: 'NOT_FOUND', message: 'No invoices found for provided ids' }, status: 404 };
  }

  await prisma.$executeRaw(
    Prisma.sql`
      UPDATE tax_invoices
      SET tax_invoice_date = ${parsedDate},
          updated_at = NOW()
      WHERE id = ANY(${invoiceIds}::uuid[])
    `
  );

  return { updated: snapshots.length, undo: snapshots, invoiceDate: invoiceDate };
}

async function undoUpdate(previous: Snapshot[]) {
  if (!Array.isArray(previous) || previous.length === 0) {
    return { error: { code: 'INVALID_REQUEST', message: 'previous snapshots required for undo' }, status: 400 };
  }

  const updates = previous.map((snap) =>
    prisma.$executeRaw(
      Prisma.sql`
        UPDATE tax_invoices
        SET tax_invoice_date = ${snap.tax_invoice_date ? new Date(snap.tax_invoice_date) : null},
            updated_at = NOW()
        WHERE id = ${snap.id}::uuid
      `
    )
  );

  await prisma.$transaction(updates);
  return { restored: previous.length };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action === 'undo' ? 'undo' : 'apply';

    if (action === 'undo') {
      const previous = body?.previous;
      const result = await undoUpdate(previous);
      if ('error' in result) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }
      return NextResponse.json({ restored: result.restored });
    }

    const invoiceIds = Array.isArray(body?.invoiceIds) ? body.invoiceIds : [];
    const invoiceDate = typeof body?.invoiceDate === 'string' ? body.invoiceDate.trim() : '';

    if (!invoiceDate) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'invoiceDate is required' } },
        { status: 400 }
      );
    }

    const result = await applyUpdate(invoiceIds, invoiceDate);
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      updated: result.updated,
      undo: result.undo,
      invoiceDate: result.invoiceDate
    });
  } catch (error) {
    console.error('Failed to update invoice date(s)', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to update invoice date(s)' } },
      { status: 500 }
    );
  }
}
