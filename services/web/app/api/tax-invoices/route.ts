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
  const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 500)
  const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0)

  let rows: {
    id: string
    invoice_number: string
    tax_invoice_date: Date | null
    trx_code: string | null
    buyer_name: string | null
    tin: string | null
    created_at: Date | null
  }[] = []

  let totalCount = 0

  if (filterTin) {
    const countResult = await prisma.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*) as count FROM tax_invoices WHERE tin = ${filterTin}`
    totalCount = Number(countResult[0]?.count || 0)
    rows = await prisma.$queryRaw<
      typeof rows
    >`SELECT id, invoice_number, tax_invoice_date, trx_code, buyer_name, tin, created_at FROM tax_invoices WHERE tin = ${filterTin} ORDER BY created_at DESC NULLS LAST LIMIT ${limit} OFFSET ${offset}`
  } else {
    const countResult = await prisma.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*) as count FROM tax_invoices`
    totalCount = Number(countResult[0]?.count || 0)
    rows = await prisma.$queryRaw<
      typeof rows
    >`SELECT id, invoice_number, tax_invoice_date, trx_code, buyer_name, tin, created_at FROM tax_invoices ORDER BY created_at DESC NULLS LAST LIMIT ${limit} OFFSET ${offset}`
  }

  return NextResponse.json({
    invoices: rows.map((row) => ({
      id: row.id,
      invoiceNumber: row.invoice_number,
      invoiceDate: row.tax_invoice_date ? row.tax_invoice_date.toISOString().slice(0, 10) : null,
      trxCode: row.trx_code,
      buyerName: row.buyer_name,
      sellerName,
      status: 'complete'
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
