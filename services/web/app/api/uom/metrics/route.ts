import { NextResponse } from 'next/server';
import { getResolutionMetrics } from '@/lib/uomResolver';

export async function GET() {
  try {
    const metrics = getResolutionMetrics();

    return NextResponse.json(metrics);
  } catch (error) {
    console.error('Error fetching UOM metrics:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch metrics' } },
      { status: 500 }
    );
  }
}
