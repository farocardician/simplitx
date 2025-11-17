import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withSession } from '@/lib/session';
import { createReadStream, statSync, existsSync } from 'fs';
import { join } from 'path';
import archiver from 'archiver';
import { PassThrough } from 'stream';

export const POST = withSession(async (
  req: NextRequest,
  { sessionId }: { sessionId: string }
) => {
  const body = await req.json();
  const { jobIds } = body;

  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'Job IDs are required' } },
      { status: 400 }
    );
  }

  // Verify ownership and get jobs
  const jobs = await prisma.job.findMany({
    where: {
      id: { in: jobIds },
      ownerSessionId: sessionId,
      status: 'complete'
    },
    select: {
      id: true,
      originalFilename: true,
      resultPath: true
    }
  });

  if (jobs.length === 0) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'No completed jobs found' } },
      { status: 404 }
    );
  }

  // Filter jobs with existing result files
  const validJobs = jobs.filter(job => {
    if (!job.resultPath) return false;
    const filePath = join(process.cwd(), job.resultPath);
    return existsSync(filePath);
  });

  if (validJobs.length === 0) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'No result files found' } },
      { status: 404 }
    );
  }

  // Create ZIP stream
  const archive = archiver('zip', { zlib: { level: 9 } });
  const pass = new PassThrough();

  // Pipe archive to pass-through stream
  archive.pipe(pass);

  // Add files to archive
  validJobs.forEach(job => {
    const filePath = join(process.cwd(), job.resultPath!);
    const fileName = job.originalFilename 
      ? job.originalFilename.replace(/\.pdf$/i, '.xml')
      : `${job.id}.xml`;
    
    archive.file(filePath, { name: fileName });
  });

  // Finalize archive
  archive.finalize();

  // Update download counts
  await prisma.job.updateMany({
    where: { id: { in: validJobs.map(job => job.id) } },
    data: {
      downloadCount: { increment: 1 },
      firstDownloadAt: new Date()
    }
  });

  // Return ZIP file
  const response = new NextResponse(pass as any);
  response.headers.set('Content-Type', 'application/zip');
  response.headers.set(
    'Content-Disposition',
    `attachment; filename="xml-files-${Date.now()}.zip"`
  );

  return response;
});