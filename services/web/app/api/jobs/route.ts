import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withSession } from '@/lib/session';
import { formatBytes } from '@/lib/bytes';

export const GET = withSession(async (req: NextRequest, { sessionId }: { sessionId: string }) => {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
  const since = searchParams.get('since'); // ISO timestamp for incremental
  
  const where: any = { ownerSessionId: sessionId };
  
  if (status) {
    where.status = status;
  }
  
  if (since) {
    where.updatedAt = { gte: new Date(since) };
  }
  
  const jobs = await prisma.job.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      originalFilename: true,
      bytes: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      startedAt: true,
      completedAt: true,
      errorCode: true,
      errorMessage: true,
      mapping: true
    }
  });
  
  // Count active jobs for stop condition
  const activeCount = await prisma.job.count({
    where: {
      ownerSessionId: sessionId,
      status: { in: ['uploaded', 'queued', 'processing'] }
    }
  });
  
  return NextResponse.json({
    jobs: jobs.map((job: any) => ({
      id: job.id,
      filename: job.originalFilename,
      bytes: Number(job.bytes),
      sizeFormatted: formatBytes(Number(job.bytes)),
      status: job.status,
      mapping: job.mapping,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      startedAt: job.startedAt?.toISOString() || null,
      completedAt: job.completedAt?.toISOString() || null,
      error: job.errorMessage ? {
        code: job.errorCode,
        message: job.errorMessage
      } : null,
      canDownload: job.status === 'complete'
    })),
    activeCount,
    timestamp: new Date().toISOString() // For next incremental fetch
  });
});