import { NextResponse } from 'next/server'

const API_BASE = process.env.KURS_PAJAK_API_BASE || process.env.NEXT_PUBLIC_KURS_PAJAK_API_BASE

export async function POST() {
  if (!API_BASE) {
    return NextResponse.json(
      { error: 'KURS_PAJAK_API_BASE is not configured' },
      { status: 500 }
    )
  }

  try {
    const response = await fetch(`${API_BASE}/scrape/latest`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      const message = data?.detail || data?.error || 'Failed to scrape data'
      return NextResponse.json(
        { error: message },
        { status: response.status }
      )
    }

    const payload = await response.json()
    return NextResponse.json(payload, { status: 200 })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to contact Kurs Pajak service' },
      { status: 502 }
    )
  }
}
