import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import { join } from 'path'
import { readFileSync } from 'fs'
import { prisma } from '@/lib/prisma'

const CONFIG_PATH = join(process.cwd(), 'services', 'config', 'invoice_pt_sensient.json')
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3'
const SCRIPT_PATH = join(process.cwd(), 'services', 'xls2sql', 'stages', 's01_sql2xml.py')

function loadMappingPath(): string | null {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    const cfg = JSON.parse(raw)
    const profiles = (cfg?.json2xml?.profiles || {}) as Record<string, any>
    const defaultProfile = profiles.default || Object.values(profiles)[0]
    const mapping = defaultProfile?.mapping || null
    if (!mapping) return null
    return mapping.startsWith('/') ? mapping : join(process.cwd(), 'services', 'json2xml', mapping)
  } catch (e) {
    return null
  }
}

async function runXml(invoices: string[], mapping: string | null, pretty: boolean) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const args = [SCRIPT_PATH]
    invoices.forEach((inv) => {
      args.push('--invoice', inv)
    })
    if (mapping) {
      args.push('--mapping', mapping)
    }
    if (pretty) {
      args.push('--pretty')
    }

    const proc = spawn(PYTHON_BIN, args, { cwd: process.cwd() })
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

export const dynamic = 'force-dynamic'

export const POST = async (req: NextRequest) => {
  const body = await req.json().catch(() => null)
  const invoiceNumbers: string[] = Array.isArray(body?.invoiceNumbers) ? body.invoiceNumbers : []
  const pretty = body?.pretty === true

  if (invoiceNumbers.length === 0) {
    return NextResponse.json({ error: { code: 'NO_INVOICES', message: 'No invoice numbers provided' } }, { status: 400 })
  }

  const invoiceStatuses = await prisma.$queryRaw<{ invoice_number: string; is_complete: boolean | null }[]>`
    SELECT invoice_number, is_complete
    FROM tax_invoices
    WHERE invoice_number = ANY(${invoiceNumbers}::text[])
  `

  const incompleteInvoices = invoiceStatuses
    .filter((row) => row.is_complete !== true)
    .map((row) => row.invoice_number)

  if (incompleteInvoices.length > 0) {
    return NextResponse.json(
      {
        error: {
          code: 'INCOMPLETE_INVOICE',
          message: `Cannot download XML for incomplete invoices: ${incompleteInvoices.slice(0, 5).join(', ')}`
        },
        details: { invoices: incompleteInvoices }
      },
      { status: 400 }
    )
  }

  const mappingPath = loadMappingPath()
  const result = await runXml(invoiceNumbers, mappingPath, pretty)

  if (result.code !== 0) {
    return NextResponse.json(
      { error: { code: 'XML_FAILED', message: result.stderr || result.stdout || 'XML generation failed' } },
      { status: 500 }
    )
  }

  const filename = invoiceNumbers.length === 1 ? `${invoiceNumbers[0]}.xml` : `invoices-${invoiceNumbers.length}.xml`

  return new NextResponse(result.stdout, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`
    }
  })
}
