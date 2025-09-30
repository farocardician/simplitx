import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    const uoms = await prisma.unitOfMeasure.findMany({
      orderBy: { name: 'asc' }
    });

    return NextResponse.json(uoms);
  } catch (error) {
    console.error('Error fetching UOMs:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch UOM list' } },
      { status: 500 }
    );
  }
}
