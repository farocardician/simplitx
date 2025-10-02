import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/transaction-codes
 * Fetch all transaction codes for TrxCode dropdown
 */
export async function GET() {
  try {
    const codes = await prisma.transactionCode.findMany({
      select: {
        code: true,
        name: true,
        description: true
      },
      orderBy: {
        code: 'asc'
      }
    });

    return NextResponse.json(codes);
  } catch (error) {
    console.error('Error fetching transaction codes:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch transaction codes' } },
      { status: 500 }
    );
  }
}
