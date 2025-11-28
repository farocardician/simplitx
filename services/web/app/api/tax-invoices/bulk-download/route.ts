import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

const SQL2XML_URL = process.env.SQL2XML_URL || 'http://sql2xml:8000'
const SQL2XML_PIPELINE = process.env.SQL2XML_PIPELINE || 'invoice_pt_sensient.json'

export const dynamic = 'force-dynamic'

export const POST = async (req: NextRequest) => {
  const body = await req.json().catch(() => null)
  const invoiceIds: string[] = Array.isArray(body?.invoiceIds) ? body.invoiceIds : []
  const pretty = body?.pretty === true

  if (invoiceIds.length === 0) {
    return NextResponse.json({ error: { code: 'NO_INVOICES', message: 'No invoice IDs provided' } }, { status: 400 })
  }

  const filterClause = Prisma.sql`id::text = ANY(${invoiceIds}::text[])`

  const invoiceRows = await prisma.$queryRaw<{
    id: string
    invoice_number: string
    is_complete: boolean | null
    buyer_party_id: string | null
    buyer_tin: string | null
    buyer_name: string | null
    tin: string | null
  }[]>`
    SELECT
      id::text as id,
      invoice_number,
      is_complete,
      buyer_party_id::text as buyer_party_id,
      buyer_tin,
      buyer_name,
      tin
    FROM tax_invoices
    WHERE ${filterClause}
  `

  if (invoiceRows.length === 0) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'No invoices found for provided IDs' } },
      { status: 404 }
    )
  }

  const incompleteInvoices = invoiceRows
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

  const buyerBuckets = new Map<string, string[]>()
  const missingBuyer: string[] = []
  invoiceRows.forEach((row) => {
    const buyerKey = (row.buyer_party_id || row.buyer_tin || row.buyer_name || '').trim()
    if (!buyerKey) {
      missingBuyer.push(row.invoice_number)
      return
    }
    const normalized = buyerKey.toLowerCase()
    const list = buyerBuckets.get(normalized) || []
    list.push(row.invoice_number)
    buyerBuckets.set(normalized, list)
  })

  if (missingBuyer.length > 0) {
    return NextResponse.json(
      {
        error: {
          code: 'BUYER_UNKNOWN',
          message: 'Cannot merge invoices because buyer information is missing.',
        },
        details: { invoices: missingBuyer },
      },
      { status: 400 }
    )
  }

  if (buyerBuckets.size > 1) {
    const sample = Array.from(buyerBuckets.values())[0]?.slice(0, 3).join(', ')
    return NextResponse.json(
      {
        error: {
          code: 'BUYER_MISMATCH',
          message: `Merging requires the same buyer. Found ${buyerBuckets.size} buyers${sample ? ` (e.g., ${sample})` : ''}.`,
        },
      },
      { status: 400 }
    )
  }

  const tins = new Set((invoiceRows || []).map((row) => row.tin).filter(Boolean))
  if (tins.size > 1) {
    return NextResponse.json(
      {
        error: {
          code: 'TIN_MISMATCH',
          message: `Cannot merge invoices with different seller TINs (${Array.from(tins).join(', ')}).`,
        },
      },
      { status: 400 }
    )
  }

  let sql2xmlResponse: globalThis.Response
  try {
    sql2xmlResponse = await fetch(`${SQL2XML_URL}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoiceIds,
        pipeline: SQL2XML_PIPELINE,
        pretty,
      }),
    })
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'SQL2XML_UNAVAILABLE', message: 'SQL2XML service is unavailable' } },
      { status: 502 }
    )
  }

  if (!sql2xmlResponse.ok) {
    const payload = await sql2xmlResponse.json().catch(() => null)
    const code = payload?.code || payload?.detail?.code || 'XML_FAILED'
    const message = payload?.message || payload?.detail?.message || 'XML generation failed'
    return NextResponse.json(
      { error: { code, message }, details: payload?.detail || payload },
      { status: sql2xmlResponse.status }
    )
  }

  const buffer = Buffer.from(await sql2xmlResponse.arrayBuffer())
  const serviceDisposition = sql2xmlResponse.headers.get('content-disposition')
  const headers = new Headers()
  headers.set('Content-Type', 'application/xml; charset=utf-8')
  headers.set('Content-Disposition', serviceDisposition || `attachment; filename="invoices-${invoiceIds.length}.xml"`)

  return new NextResponse(buffer, {
    status: 200,
    headers,
  })
}
