import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withSession } from '@/lib/session';
import { createReadStream, statSync } from 'fs';
import { join } from 'path';

export const GET = withSession(async (
  req: NextRequest, 
  { sessionId }: { sessionId: string },
  { params }: { params: { id: string } }
) => {
  // Verify ownership
  const job = await prisma.job.findFirst({
    where: {
      id: params.id,
      ownerSessionId: sessionId
    }
  });
  
  if (!job) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: "This file isn't yours" } },
      { status: 403 }
    );
  }
  
  if (job.status !== 'complete') {
    return NextResponse.json(
      { error: { code: 'NOT_READY', message: 'Conversion not finished yet' } },
      { status: 409 }
    );
  }
  
  if (!job.artifactPath) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'Artifact file not available' } },
      { status: 404 }
    );
  }
  
  // Check if file exists
  const filePath = join(process.cwd(), job.artifactPath);
  console.log('Looking for artifact file at:', filePath);
  
  try {
    const stats = statSync(filePath);
    
    // Update download count (same counter as XML downloads)
    await prisma.job.update({
      where: { id: job.id },
      data: {
        downloadCount: { increment: 1 },
        firstDownloadAt: job.firstDownloadAt || new Date()
      }
    });
    
    // Stream file
    const stream = createReadStream(filePath);
    const response = new NextResponse(stream as any);
    
    response.headers.set('Content-Type', 'application/zip');
    response.headers.set('Content-Length', stats.size.toString());
    response.headers.set(
      'Content-Disposition', 
      `attachment; filename="${job.id}-artifacts.zip"`
    );
    
    return response;
    
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return NextResponse.json(
        { error: { code: 'EXPIRED', message: 'Artifact file was removed by retention' } },
        { status: 404 }
      );
    }
    throw error;
  }
});