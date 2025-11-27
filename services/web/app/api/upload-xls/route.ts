import { NextRequest, NextResponse } from 'next/server'
import { mkdir, writeFile } from 'fs/promises'
import { join, extname } from 'path'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'

const MAX_XLS_MB = parseInt(process.env.XLS_MAX_MB || '50', 10)
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const EXCEL_MIME_TYPES = [
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]
const EXCEL_EXTENSIONS = ['.xls', '.xlsx']

function isExcelFile(file: File): boolean {
  const fileExt = extname(file.name || '').toLowerCase()
  const mimeOk = !file.type
    || EXCEL_MIME_TYPES.includes(file.type || '')
    || file.type === 'application/octet-stream'
  const extOk = EXCEL_EXTENSIONS.includes(fileExt)
  return extOk && mimeOk
}

async function runPython(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    // Parse DATABASE_URL or use individual env vars
    const databaseUrl = process.env.DATABASE_URL || ''
    let dbEnv: Record<string, string> = {}

    if (databaseUrl) {
      // Parse postgres://user:password@host:port/database
      try {
        const url = new URL(databaseUrl)
        dbEnv = {
          DB_HOST: url.hostname,
          DB_PORT: url.port || '5432',
          DB_NAME: url.pathname.slice(1), // Remove leading /
          DB_USER: url.username,
          DB_PASSWORD: url.password
        }
      } catch {
        // Fallback to individual env vars
        dbEnv = {
          DB_HOST: process.env.DB_HOST || 'postgres',
          DB_PORT: process.env.DB_PORT || '5432',
          DB_NAME: process.env.DB_NAME || 'pdf_jobs',
          DB_USER: process.env.DB_USER || 'postgres',
          DB_PASSWORD: process.env.DB_PASSWORD || 'postgres'
        }
      }
    } else {
      // Use individual env vars
      dbEnv = {
        DB_HOST: process.env.DB_HOST || 'postgres',
        DB_PORT: process.env.DB_PORT || '5432',
        DB_NAME: process.env.DB_NAME || 'pdf_jobs',
        DB_USER: process.env.DB_USER || 'postgres',
        DB_PASSWORD: process.env.DB_PASSWORD || 'postgres'
      }
    }

    const proc = spawn(PYTHON_BIN, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...dbEnv }
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (err) => {
      stderr += err.message
      resolve({ code: -1, stdout, stderr })
    })
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function extractBatchId(output: string): string | null {
  const match = output.match(/Batch ID:\s*([0-9a-fA-F-]{36})/)
  return match ? match[1] : null
}

async function saveUpload(buffer: Buffer, originalName: string) {
  const uploadsDir = join(process.cwd(), 'uploads', 'xls')
  await mkdir(uploadsDir, { recursive: true })
  const ext = extname(originalName || '').toLowerCase() || '.xlsx'
  const fileId = randomUUID()
  const filename = `${fileId}${ext}`
  const fullPath = join(uploadsDir, filename)
  await writeFile(fullPath, buffer)
  return fullPath
}

export const POST = async (req: NextRequest) => {
  const formData = await req.formData()
  const file = formData.get('file') as File | null

  if (!file) {
    return NextResponse.json({ error: { code: 'NO_FILE', message: 'File is required' } }, { status: 400 })
  }

  if (!isExcelFile(file)) {
    return NextResponse.json({ error: { code: 'INVALID_TYPE', message: 'Only XLS/XLSX files are supported' } }, { status: 400 })
  }

  if (file.size > MAX_XLS_MB * 1024 * 1024) {
    return NextResponse.json({ error: { code: 'TOO_LARGE', message: `File exceeds ${MAX_XLS_MB}MB limit` } }, { status: 413 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const savedPath = await saveUpload(buffer, file.name)

  // Determine script paths (Docker vs local)
  const scriptsBase = process.env.NODE_ENV === 'production' || process.env.DOCKER_ENV
    ? '/xls2sql/stages'
    : 'services/xls2sql/stages'

  // Stage 1: import XLS
  const stage1 = await runPython([`${scriptsBase}/s01_postgreimport_sensient.py`, savedPath])
  if (stage1.code !== 0) {
    return NextResponse.json(
      { error: { code: 'IMPORT_FAILED', message: stage1.stderr || stage1.stdout || 'Import failed' } },
      { status: 500 }
    )
  }

  const batchId = extractBatchId(stage1.stdout || '')
  if (!batchId) {
    return NextResponse.json(
      { error: { code: 'NO_BATCH_ID', message: 'Could not extract batch_id from import output' }, logs: stage1.stdout },
      { status: 500 }
    )
  }

  // Stage 2: validate/resolve buyers
  const stage2 = await runPython([`${scriptsBase}/s02_validate_resolve_sensient.py`, '--batch-id', batchId])
  if (stage2.code !== 0) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: stage2.stderr || stage2.stdout || 'Validation failed' }, batchId },
      { status: 500 }
    )
  }

  // Stage 3: build tax_invoices
  const stage3 = await runPython([`${scriptsBase}/s03_build_invoices.py`, '--batch-id', batchId])
  if (stage3.code !== 0) {
    return NextResponse.json(
      { error: { code: 'BUILD_FAILED', message: stage3.stderr || stage3.stdout || 'Invoice build failed' }, batchId },
      { status: 500 }
    )
  }

  const invoices = await prisma.$queryRaw<
    { id: string; invoice_number: string; tax_invoice_date: Date | null; trx_code: string | null; buyer_name: string | null }[]
  >(
    Prisma.sql`SELECT id, invoice_number, tax_invoice_date, trx_code, buyer_name FROM tax_invoices WHERE batch_id = ${batchId}::uuid ORDER BY invoice_number`
  )

  return NextResponse.json({
    status: 'ok',
    batchId,
    invoices: invoices.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoice_number,
      invoiceDate: inv.tax_invoice_date ? inv.tax_invoice_date.toISOString().slice(0, 10) : null,
      trxCode: inv.trx_code,
      buyerName: inv.buyer_name
    }))
  })
}
