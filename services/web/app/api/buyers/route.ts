import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export const GET = async (req: NextRequest) => {
  try {
    // Get unique buyers from tax_invoices
    const buyers = await prisma.$queryRaw<
      { id: string; buyer_name: string }[]
    >`
      SELECT DISTINCT buyer_party_id as id, buyer_name
      FROM tax_invoices_enriched
      WHERE buyer_party_id IS NOT NULL
        AND buyer_name IS NOT NULL
      ORDER BY buyer_name ASC
    `

    return NextResponse.json({
      buyers: buyers.map(b => ({ id: b.id, name: b.buyer_name }))
    })
  } catch (error) {
    console.error('Error fetching buyers:', error)
    return NextResponse.json(
      { error: 'Failed to fetch buyers' },
      { status: 500 }
    )
  }
}
