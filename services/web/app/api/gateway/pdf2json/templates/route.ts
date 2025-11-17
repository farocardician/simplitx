import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://gateway:8000'

export async function GET() {
  try {
    const response = await fetch(`${GATEWAY_URL}/pdf2json/templates`, {
      method: 'GET',
      cache: 'no-store',
      next: { revalidate: 0 },
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    })

    if (!response.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch templates from gateway' },
        { status: response.status }
      )
    }

    const data = await response.json()
    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    })
  } catch (error) {
    console.error('Error fetching templates:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}