import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { readFileSync } from 'fs'
import { join } from 'path'

const CONFIG_PATH = join(process.cwd(), 'services', 'config', 'invoice_pt_sensient.json')

function loadConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch (e) {
    return {}
  }
}

export const dynamic = 'force-dynamic'

export const GET = async (req: NextRequest) => {
  const cfg = loadConfig()
  const queueCfg = cfg.queue || {}
  const sellerName = queueCfg.seller_name || 'Seller'
  const filterTin: string | undefined = queueCfg.filter?.tin
  const { searchParams } = new URL(req.url)
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 500)
  const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0)

  // NEW: Filter and sort params
  const buyerFilter = searchParams.get('buyer')
  const sortField = searchParams.get('sort') || 'date'
  const sortDir = searchParams.get('dir') || 'desc'

  // Build WHERE clause
  let whereClause = Prisma.sql`WHERE 1=1`
  if (filterTin) {
    whereClause = Prisma.sql`${whereClause} AND tin = ${filterTin}`
  }
  if (buyerFilter) {
    whereClause = Prisma.sql`${whereClause} AND buyer_party_id = ${buyerFilter}::uuid`
  }

  // Build ORDER BY clause
  let orderClause = Prisma.sql`ORDER BY created_at DESC NULLS LAST`
  if (sortField === 'date') {
    orderClause = sortDir === 'asc'
      ? Prisma.sql`ORDER BY tax_invoice_date ASC NULLS LAST, created_at ASC`
      : Prisma.sql`ORDER BY tax_invoice_date DESC NULLS LAST, created_at DESC`
  } else if (sortField === 'invoice_number') {
    orderClause = sortDir === 'asc'
      ? Prisma.sql`ORDER BY invoice_number ASC`
      : Prisma.sql`ORDER BY invoice_number DESC`
  } else if (sortField === 'buyer_name') {
    orderClause = sortDir === 'asc'
      ? Prisma.sql`ORDER BY buyer_name ASC NULLS LAST`
      : Prisma.sql`ORDER BY buyer_name DESC NULLS LAST`
  }

  // Count query
  const countResult = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*) as count FROM tax_invoices ${whereClause}
  `
  const totalCount = Number(countResult[0]?.count || 0)

  // Data query
  const rows = await prisma.$queryRaw<
    {
      id: string
      invoice_number: string
      tax_invoice_date: Date | null
      trx_code: string | null
      buyer_name: string | null
      buyer_party_id: string | null
      tin: string | null
      created_at: Date | null
      is_complete: boolean | null
      missing_fields: string[] | null
    }[]
  >`
    SELECT
      id,
      invoice_number,
      tax_invoice_date,
      trx_code,
      buyer_name,
      buyer_party_id,
      tin,
      created_at,
      is_complete,
      missing_fields
    FROM tax_invoices
    ${whereClause}
    ${orderClause}
    LIMIT ${limit}
    OFFSET ${offset}
  `

  return NextResponse.json({
    invoices: rows.map((row) => ({
      id: row.id,
      invoiceNumber: row.invoice_number,
      invoiceDate: row.tax_invoice_date ? row.tax_invoice_date.toISOString().slice(0, 10) : null,
      trxCode: row.trx_code,
      buyerName: row.buyer_name,
      buyerPartyId: row.buyer_party_id,
      sellerName,
      isComplete: row.is_complete ?? true,
      missingFields: row.missing_fields || [],
      status: row.is_complete === false ? 'incomplete' : 'complete'
    })),
    sellerName,
    pagination: {
      total: totalCount,
      limit,
      offset,
      hasMore: offset + rows.length < totalCount
    }
  })
}

export const DELETE = async (req: NextRequest) => {
  const body = await req.json().catch(() => null)
  const invoiceNumbers: string[] = Array.isArray(body?.invoiceNumbers) ? body.invoiceNumbers : []

  if (invoiceNumbers.length === 0) {
    return NextResponse.json({ error: { code: 'NO_INVOICES', message: 'No invoice numbers provided' } }, { status: 400 })
  }

  const values = Prisma.join(invoiceNumbers.map((inv) => Prisma.sql`${inv}`))
  const deleted = await prisma.$executeRaw(Prisma.sql`DELETE FROM tax_invoices WHERE invoice_number IN (${values})`)

  return NextResponse.json({ deleted })
}
