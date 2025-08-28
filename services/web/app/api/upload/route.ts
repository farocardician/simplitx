import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'
import { prisma } from '@/lib/prisma'
import { withSession } from '@/lib/session'

async function uploadHandler(req: NextRequest, { sessionId }: { sessionId: string }) {
  const formData = await req.formData();
  const file = formData.get('file') as File;
  
  // Validation
  if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
    return NextResponse.json(
      { error: { code: 'NOT_PDF', message: 'Only PDF files are supported' } },
      { status: 400 }
    );
  }
  
  if (file.size > 50 * 1024 * 1024) {
    return NextResponse.json(
      { error: { code: 'TOO_LARGE', message: 'File exceeds 50 MB limit' } },
      { status: 413 }
    );
  }
  
  // Compute hash
  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  
  // Check for duplicates
  const existing = await prisma.job.findFirst({
    where: {
      ownerSessionId: sessionId,
      sha256,
      mapping: 'pt_simon_invoice_v1',
      bytes: BigInt(file.size)
    }
  });
  
  if (existing) {
    return NextResponse.json({
      job: {
        id: existing.id,
        filename: existing.originalFilename,
        bytes: Number(existing.bytes),
        status: existing.status,
        created_at: existing.createdAt.toISOString()
      },
      deduped_from: existing.id
    });
  }
  
  // Create job
  const job = await prisma.job.create({
    data: {
      ownerSessionId: sessionId,
      originalFilename: file.name,
      contentType: file.type || 'application/pdf',
      bytes: BigInt(file.size),
      sha256,
      mapping: 'pt_simon_invoice_v1',
      status: 'uploaded',
      uploadPath: null // Will be set after file write
    }
  });
  
  // Create uploads directory if it doesn't exist
  const uploadsDir = join(process.cwd(), 'uploads')
  await mkdir(uploadsDir, { recursive: true })
  
  // Save file
  const uploadPath = `uploads/${job.id}.pdf`;
  const fullPath = join(process.cwd(), uploadPath);
  await writeFile(fullPath, buffer);
  
  // Update job with path
  const updatedJob = await prisma.job.update({
    where: { id: job.id },
    data: { 
      uploadPath,
      status: 'queued',
      queuedAt: new Date()
    }
  });
  
  return NextResponse.json({ 
    job: {
      id: updatedJob.id,
      filename: updatedJob.originalFilename,
      bytes: Number(updatedJob.bytes),
      status: updatedJob.status,
      created_at: updatedJob.createdAt.toISOString()
    }
  });
}

export const POST = withSession(uploadHandler);

export async function GET() {
  return NextResponse.json({
    message: 'PDF Upload API',
    version: '1.0.0',
    endpoints: {
      upload: 'POST /api/upload',
      healthcheck: 'GET /api/healthz'
    }
  })
}