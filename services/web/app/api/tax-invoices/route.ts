import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export const GET = async (req: NextRequest) => {
  // Get optional seller filter from query params
  const { searchParams } = new URL(req.url)
  const sellerIdParam = searchParams.get('seller_id')

  let filterTin: string | null = null
  let sellerName = 'All Sellers'

  // If seller_id provided, fetch their TIN for filtering
  if (sellerIdParam) {
    const sellerParty = await prisma.parties.findUnique({
      where: { id: sellerIdParam },
      select: { tin_normalized: true, display_name: true }
    });

    if (sellerParty && sellerParty.tin_normalized) {
      filterTin = sellerParty.tin_normalized
      sellerName = sellerParty.display_name || 'Unknown Seller'
    }
  }

  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 500)
  const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0)

  // NEW: Filter and sort params
  const buyerFilter = searchParams.get('buyer')
  const invoiceNumbersParam = searchParams.get('invoices') || searchParams.get('invoiceNumbers')
  const statusFilter = searchParams.get('status')
  const sortField = searchParams.get('sort') || 'date'
  const sortDir = searchParams.get('dir') || 'desc'

  // Build WHERE clause
  let whereClause = Prisma.sql`WHERE 1=1`
  if (filterTin) {
    whereClause = Prisma.sql`${whereClause} AND tin = ${filterTin}`
  }
  if (buyerFilter) {
    whereClause = Prisma.sql`${whereClause} AND buyer_party_id::text = ${buyerFilter}`
  }
  if (invoiceNumbersParam) {
    const list = invoiceNumbersParam
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
    if (list.length > 0) {
      const values = Prisma.join(list.map((inv) => Prisma.sql`${inv}`))
      whereClause = Prisma.sql`${whereClause} AND invoice_number IN (${values})`
    }
  }
  if (statusFilter === 'complete') {
    whereClause = Prisma.sql`${whereClause} AND is_complete = true`
  } else if (statusFilter === 'incomplete') {
    whereClause = Prisma.sql`${whereClause} AND (is_complete = false OR is_complete IS NULL)`
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
      item_count: number | null
      grand_total: number | null
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
      missing_fields,
      (
        SELECT COUNT(*)::int
        FROM tax_invoice_items ti
        WHERE ti.tax_invoice_id = tax_invoices.id
      ) AS item_count,
      (
        SELECT COALESCE(SUM(ti.tax_base), 0)
        FROM tax_invoice_items ti
        WHERE ti.tax_invoice_id = tax_invoices.id
      ) AS grand_total
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
      status: row.is_complete === false ? 'incomplete' : 'complete',
      itemCount: row.item_count ?? 0,
      grandTotal: row.grand_total ?? 0
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

  // Get job_ids from invoices being deleted (for cleanup)
  const values = Prisma.join(invoiceNumbers.map((inv) => Prisma.sql`${inv}`))
  const affectedJobIds = await prisma.$queryRaw<{ job_id: string }[]>(
    Prisma.sql`SELECT DISTINCT job_id FROM tax_invoices WHERE invoice_number IN (${values}) AND job_id IS NOT NULL`
  )

  // Delete the invoices
  const deleted = await prisma.$executeRaw(Prisma.sql`DELETE FROM tax_invoices WHERE invoice_number IN (${values})`)

  // Clean up orphaned job_config records (jobs with no remaining invoices)
  let jobsCleanedUp = 0
  for (const { job_id } of affectedJobIds) {
    const remainingCount = await prisma.$queryRaw<{ count: bigint }[]>(
      Prisma.sql`SELECT COUNT(*) as count FROM tax_invoices WHERE job_id = ${job_id}::uuid`
    )

    if (remainingCount[0]?.count === BigInt(0)) {
      // No more invoices for this job - delete job_config
      await prisma.$executeRaw(
        Prisma.sql`DELETE FROM job_config WHERE job_id = ${job_id}::uuid`
      )
      jobsCleanedUp++
    }
  }

  return NextResponse.json({ deleted, jobsCleanedUp })
}
