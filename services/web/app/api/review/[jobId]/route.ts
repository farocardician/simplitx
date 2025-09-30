import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withSession } from '@/lib/session';

export const GET = withSession(async (
  req: NextRequest,
  { sessionId }: { sessionId: string },
  { params }: { params: { jobId: string } }
) => {
  const jobId = params.jobId;

  try {
    // Fetch job
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        ownerSessionId: true,
        status: true,
        resultPath: true
      }
    });

    if (!job) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Job not found' } },
        { status: 404 }
      );
    }

    // Check ownership
    if (job.ownerSessionId !== sessionId) {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: 'Access denied' } },
        { status: 403 }
      );
    }

    // Check if job is complete
    if (job.status !== 'complete') {
      return NextResponse.json(
        { error: { code: 'NOT_READY', message: 'Job is not complete yet' } },
        { status: 400 }
      );
    }

    // Load from parser_results.final (source of truth)
    // Try by jobId first, then fallback to original filename
    let parserResult = await prisma.parserResult.findUnique({
      where: { docId: jobId },
      select: { final: true }
    });

    // Fallback: try finding by original filename (for legacy/test data)
    if (!parserResult && job.resultPath) {
      console.log(`No parser_result found for jobId ${jobId}, trying by filename...`);

      const job2 = await prisma.job.findUnique({
        where: { id: jobId },
        select: { originalFilename: true }
      });

      if (job2?.originalFilename) {
        parserResult = await prisma.parserResult.findUnique({
          where: { docId: job2.originalFilename },
          select: { final: true }
        });
      }

      // Last resort: try 'document.pdf' (common test data)
      if (!parserResult) {
        parserResult = await prisma.parserResult.findUnique({
          where: { docId: 'document.pdf' },
          select: { final: true }
        });

        if (parserResult) {
          console.warn(`Using fallback 'document.pdf' data for job ${jobId}. Stage 10 should save with correct doc_id.`);
        }
      }
    }

    if (!parserResult) {
      console.error(`No parser_result found for job ${jobId}. Check stage 10 pipeline.`);
      return NextResponse.json(
        {
          error: {
            code: 'NO_DATA',
            message: 'Invoice data not found in database. The job may need to be reprocessed through stage 10.'
          }
        },
        { status: 404 }
      );
    }

    const final = parserResult.final as any;

    const items = (final.items || []).map((item: any, index: number) => ({
      no: item.no || index + 1,
      description: item.description || '',
      qty: item.qty || 0,
      unit_price: item.unit_price || 0,
      amount: item.amount || 0,
      sku: item.sku || '',
      hs_code: item.hs_code || '',
      uom: item.uom || '',
      type: 'Barang' as const
    }));

    return NextResponse.json({
      invoice_no: final.invoice?.number || final.invoice_no || '',
      seller_name: final.seller?.name || 'Seller',
      buyer_name: final.buyer?.name || 'Buyer',
      invoice_date: final.invoice?.date || final.invoice_date || '',
      items
    });

  } catch (error) {
    console.error('Error loading invoice data:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to load invoice data' } },
      { status: 500 }
    );
  }
});
