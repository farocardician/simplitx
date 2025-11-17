import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withSession } from '@/lib/session';
import { unlink } from 'fs/promises';
import { join } from 'path';

export const DELETE = withSession(async (
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
  
  const filesToDelete = [];
  
  // Add XML result file if exists
  if (job.resultPath) {
    filesToDelete.push(join(process.cwd(), job.resultPath));
  }
  
  // Add artifact ZIP file if exists
  if (job.artifactPath) {
    filesToDelete.push(join(process.cwd(), job.artifactPath));
  }
  
  // Add original uploaded PDF file if exists
  if (job.uploadPath) {
    filesToDelete.push(join(process.cwd(), job.uploadPath));
  }
  
  // Delete all associated files
  const deletePromises = filesToDelete.map(async (filePath) => {
    try {
      await unlink(filePath);
      console.log(`Deleted file: ${filePath}`);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.warn(`Failed to delete file ${filePath}:`, error);
      }
    }
  });
  
  await Promise.all(deletePromises);
  
  // Delete job record from database
  await prisma.job.delete({
    where: { id: job.id }
  });
  
  console.log(`Job ${job.id} and associated files deleted successfully`);
  
  return new NextResponse(null, { status: 204 });
});