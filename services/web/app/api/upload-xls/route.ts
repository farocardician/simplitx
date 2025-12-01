import { NextRequest, NextResponse } from 'next/server'
import { mkdir, writeFile, readFile } from 'fs/promises'
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

function extractJobId(output: string): string | null {
  const match = output.match(/Job ID:\s*([0-9a-fA-F-]{36})/)
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

async function loadConfig(configName: string) {
  const configDir = process.env.CONFIG_DIR || join(process.cwd(), 'services', 'config')
  const configPath = join(configDir, configName)
  try {
    const content = await readFile(configPath, 'utf-8')
    return JSON.parse(content)
  } catch (error) {
    throw new Error(`Failed to load config ${configName}: ${error}`)
  }
}

export const POST = async (req: NextRequest) => {
  const startTime = Date.now()
  console.log('🚀 [XLS Upload] Starting upload process')

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const template = formData.get('template') as string | null

  if (!file) {
    return NextResponse.json({ error: { code: 'NO_FILE', message: 'File is required' } }, { status: 400 })
  }

  if (!template) {
    return NextResponse.json({ error: { code: 'NO_TEMPLATE', message: 'Template/config is required' } }, { status: 400 })
  }

  if (!isExcelFile(file)) {
    return NextResponse.json({ error: { code: 'INVALID_TYPE', message: 'Only XLS/XLSX files are supported' } }, { status: 400 })
  }

  if (file.size > MAX_XLS_MB * 1024 * 1024) {
    return NextResponse.json({ error: { code: 'TOO_LARGE', message: `File exceeds ${MAX_XLS_MB}MB limit` } }, { status: 413 })
  }

  const t1 = Date.now()
  const buffer = Buffer.from(await file.arrayBuffer())
  const savedPath = await saveUpload(buffer, file.name)
  console.log(`📁 [XLS Upload] File saved (${file.name}, ${(file.size / 1024).toFixed(2)} KB) in ${Date.now() - t1}ms`)

  // Load config to get pipeline stages
  let config: any
  try {
    config = await loadConfig(template)
  } catch (error) {
    return NextResponse.json(
      { error: { code: 'CONFIG_ERROR', message: `Failed to load config: ${error}` } },
      { status: 500 }
    )
  }

  const stages = config?.ingestion?.stages
  if (!stages || !Array.isArray(stages) || stages.length < 3) {
    return NextResponse.json(
      { error: { code: 'INVALID_CONFIG', message: 'Config must have at least 3 ingestion stages' } },
      { status: 500 }
    )
  }

  // Determine script paths (Docker vs local)
  const scriptsBase = process.env.NODE_ENV === 'production' || process.env.DOCKER_ENV
    ? '/xls2sql'
    : 'services/xls2sql'

  // Stage 1: import XLS with config
  const t2 = Date.now()
  console.log('📊 [Stage 1/3] Importing Excel data...')
  const stage1Script = join(scriptsBase, stages[0].script)
  const stage1Args = stages[0].args.map((arg: string) =>
    arg.replace('{xls}', savedPath).replace('{config}', template)
  )
  const stage1 = await runPython([stage1Script, ...stage1Args, '--config', template])
  const stage1Time = Date.now() - t2
  if (stage1.code !== 0) {
    console.error(`❌ [Stage 1/3] Failed in ${stage1Time}ms:`, stage1.stderr || stage1.stdout)
    return NextResponse.json(
      { error: { code: 'IMPORT_FAILED', message: stage1.stderr || stage1.stdout || 'Import failed' } },
      { status: 500 }
    )
  }
  // Log Python output for debugging
  if (stage1.stdout) console.log('[Stage 1 stdout]', stage1.stdout.split('\n').filter(l => l.includes('⏱️')).join('\n'))
  if (stage1.stderr) console.log('[Stage 1 stderr]', stage1.stderr.split('\n').filter(l => l.includes('⏱️')).join('\n'))
  console.log(`✅ [Stage 1/3] Import completed in ${stage1Time}ms`)

  const jobId = extractJobId(stage1.stdout || '')
  if (!jobId) {
    return NextResponse.json(
      { error: { code: 'NO_JOB_ID', message: 'Could not extract job_id from import output' }, logs: stage1.stdout },
      { status: 500 }
    )
  }
  console.log(`🆔 Job ID: ${jobId}`)

  // Stage 2: validate/resolve buyers
  const t3 = Date.now()
  console.log('🔍 [Stage 2/3] Validating and resolving buyers...')
  const stage2Script = join(scriptsBase, stages[1].script)
  const stage2Args = stages[1].args.map((arg: string) => arg.replace('{job_id}', jobId))
  const stage2 = await runPython([stage2Script, ...stage2Args])
  const stage2Time = Date.now() - t3
  if (stage2.code !== 0) {
    console.error(`❌ [Stage 2/3] Failed in ${stage2Time}ms:`, stage2.stderr || stage2.stdout)
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: stage2.stderr || stage2.stdout || 'Validation failed' }, jobId },
      { status: 500 }
    )
  }
  // Log Python output for debugging
  if (stage2.stdout) console.log('[Stage 2 stdout]', stage2.stdout.split('\n').filter(l => l.includes('⏱️')).join('\n'))
  if (stage2.stderr) console.log('[Stage 2 stderr]', stage2.stderr.split('\n').filter(l => l.includes('⏱️')).join('\n'))
  console.log(`✅ [Stage 2/3] Validation completed in ${stage2Time}ms`)

  // Stage 3: build tax_invoices
  const t4 = Date.now()
  console.log('🏗️  [Stage 3/3] Building tax invoices...')
  const stage3Script = join(scriptsBase, stages[2].script)
  const stage3Args = stages[2].args.map((arg: string) => arg.replace('{job_id}', jobId))
  const stage3 = await runPython([stage3Script, ...stage3Args])
  const stage3Time = Date.now() - t4
  if (stage3.code !== 0) {
    console.error(`❌ [Stage 3/3] Failed in ${stage3Time}ms:`, stage3.stderr || stage3.stdout)
    return NextResponse.json(
      { error: { code: 'BUILD_FAILED', message: stage3.stderr || stage3.stdout || 'Invoice build failed' }, jobId },
      { status: 500 }
    )
  }
  // Log Python output for debugging
  if (stage3.stdout) console.log('[Stage 3 stdout]', stage3.stdout.split('\n').filter(l => l.includes('⏱️') || l.includes('✓')).join('\n'))
  if (stage3.stderr) console.log('[Stage 3 stderr]', stage3.stderr.split('\n').filter(l => l.includes('⏱️') || l.includes('✓')).join('\n'))
  console.log(`✅ [Stage 3/3] Invoice build completed in ${stage3Time}ms`)

  const t5 = Date.now()
  const invoices = await prisma.$queryRaw<
    { id: string; invoice_number: string; tax_invoice_date: Date | null; trx_code: string | null; buyer_name: string | null }[]
  >(
    Prisma.sql`SELECT id, invoice_number, tax_invoice_date, trx_code, buyer_name FROM tax_invoices_enriched WHERE job_id = ${jobId}::uuid ORDER BY invoice_number`
  )
  console.log(`📋 Query invoices: ${invoices.length} invoices found in ${Date.now() - t5}ms`)

  const totalTime = Date.now() - startTime
  console.log(`✨ [XLS Upload] Total processing time: ${totalTime}ms`)
  console.log(`   ├─ File save: ${Date.now() - t1}ms`)
  console.log(`   ├─ Stage 1 (Import): ${stage1Time}ms`)
  console.log(`   ├─ Stage 2 (Validate): ${stage2Time}ms`)
  console.log(`   ├─ Stage 3 (Build): ${stage3Time}ms`)
  console.log(`   └─ Query invoices: ${Date.now() - t5}ms`)

  return NextResponse.json({
    status: 'ok',
    jobId,
    invoices: invoices.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoice_number,
      invoiceDate: inv.tax_invoice_date ? inv.tax_invoice_date.toISOString().slice(0, 10) : null,
      trxCode: inv.trx_code,
      buyerName: inv.buyer_name
    }))
  })
}
