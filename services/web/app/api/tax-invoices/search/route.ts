import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const query = (searchParams.get('q') || '').trim();
    const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 50);

    if (!query || query.length < 2) {
      return NextResponse.json({ results: [] });
    }

    const rows = await prisma.$queryRaw<
      { id: string; invoice_number: string; buyer_name: string | null }[]
    >`
      SELECT id, invoice_number, buyer_name
      FROM tax_invoices_enriched
      WHERE invoice_number ILIKE ${'%' + query + '%'}
      ORDER BY invoice_number ASC
      LIMIT ${limit}
    `;

    return NextResponse.json({
      results: rows.map((row) => ({
        id: row.id,
        invoiceNumber: row.invoice_number,
        buyerName: row.buyer_name
      }))
    });
  } catch (error) {
    console.error('Invoice search error', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to search invoices' } },
      { status: 500 }
    );
  }
}
