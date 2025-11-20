import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withSession } from '@/lib/session';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import archiver from 'archiver';
import { PassThrough } from 'stream';
import { buildMergedFilename, mergeInvoiceXmlContents } from '@/lib/xmlMerge';

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
      resultPath: true,
      mapping: true
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

  // Preserve user selection order for deterministic output
  const jobOrder = new Map<string, number>(jobIds.map((id: string, index: number) => [id, index]));
  const validJobsOrdered = [...validJobs].sort((a, b) => (jobOrder.get(a.id) ?? 0) - (jobOrder.get(b.id) ?? 0));

  const mappings = new Set(validJobsOrdered.map(job => job.mapping));
  const shouldMerge = mappings.size === 1 && validJobsOrdered.length > 1;

  let mergedXmlBuffer: Buffer | null = null;
  let mergedFileName = '';

  if (shouldMerge) {
    try {
      const xmlContents = await Promise.all(
        validJobsOrdered.map(job => readFile(join(process.cwd(), job.resultPath!), 'utf-8'))
      );
      const { mergedXml } = mergeInvoiceXmlContents(xmlContents);
      mergedXmlBuffer = Buffer.from(mergedXml, 'utf-8');
      mergedFileName = buildMergedFilename(validJobsOrdered[0].mapping, validJobsOrdered.length);
    } catch (err) {
      console.error('Failed to merge XML files:', err);
      return NextResponse.json(
        { error: { code: 'MERGE_FAILED', message: 'Failed to merge XML files for download' } },
        { status: 500 }
      );
    }
  }

  // Create ZIP stream
  const archive = archiver('zip', { zlib: { level: 9 } });
  const pass = new PassThrough();

  // Pipe archive to pass-through stream
  archive.pipe(pass);

  // Add files to archive
  validJobsOrdered.forEach(job => {
    const filePath = join(process.cwd(), job.resultPath!);
    const fileName = job.originalFilename 
      ? job.originalFilename.replace(/\.pdf$/i, '.xml')
      : `${job.id}.xml`;
    
    archive.file(filePath, { name: fileName });
  });

  if (mergedXmlBuffer) {
    archive.append(mergedXmlBuffer, { name: mergedFileName });
  }

  // Finalize archive
  archive.finalize();

  // Update download counts
  await prisma.job.updateMany({
    where: { id: { in: validJobsOrdered.map(job => job.id) } },
    data: {
      downloadCount: { increment: 1 },
      firstDownloadAt: new Date()
    }
  });

  // Determine ZIP filename
  const zipFilename = shouldMerge
    ? mergedFileName.replace('.xml', '.zip')
    : `xml-files-${Date.now()}.zip`;

  // Return ZIP file
  const response = new NextResponse(pass as any);
  response.headers.set('Content-Type', 'application/zip');
  response.headers.set(
    'Content-Disposition',
    `attachment; filename="${zipFilename}"`
  );

  return response;
});
