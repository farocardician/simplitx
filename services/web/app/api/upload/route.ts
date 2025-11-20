import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'
import { prisma } from '@/lib/prisma'
import { withSession } from '@/lib/session'

// Configure API route to allow 100MB uploads
export const maxDuration = 60 // 60 seconds timeout
export const dynamic = 'force-dynamic'

async function uploadHandler(req: NextRequest, { sessionId }: { sessionId: string }) {
  const formData = await req.formData();
  const file = formData.get('file') as File;
  const template = formData.get('template') as string | null;
  
  // Validation
  if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
    return NextResponse.json(
      { error: { code: 'NOT_PDF', message: 'Only PDF files are supported' } },
      { status: 400 }
    );
  }

  if (!template || typeof template !== 'string' || template.trim() === '') {
    return NextResponse.json(
      { error: { code: 'NO_TEMPLATE', message: 'Missing template selection' } },
      { status: 400 }
    );
  }
  
  if (file.size > 100 * 1024 * 1024) {
    return NextResponse.json(
      { error: { code: 'TOO_LARGE', message: 'File exceeds 100 MB limit' } },
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
      mapping: template,
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
      duplicate: true,
      original_job_id: existing.id,
      original_filename: existing.originalFilename
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
      mapping: template,
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
