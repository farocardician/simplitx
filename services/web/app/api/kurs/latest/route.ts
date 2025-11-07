import { NextRequest, NextResponse } from 'next/server'

const API_BASE = process.env.KURS_PAJAK_API_BASE || process.env.NEXT_PUBLIC_KURS_PAJAK_API_BASE

export async function GET(request: NextRequest) {
  if (!API_BASE) {
    return NextResponse.json(
      { error: 'KURS_PAJAK_API_BASE is not configured' },
      { status: 500 }
    )
  }

  const { searchParams } = new URL(request.url)
  const date = searchParams.get('date')

  const targetUrl = new URL('/period/latest', API_BASE)
  if (date) {
    targetUrl.searchParams.set('date', date)
  }

  try {
    const response = await fetch(targetUrl.toString(), {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })

    if (!response.ok) {
      const message = await safeParseError(response)
      return NextResponse.json(
        { error: message || 'Unable to load Kurs Pajak data' },
        { status: response.status }
      )
    }

    const payload = await response.json()
    return NextResponse.json(payload, { status: 200 })
  } catch {
    return NextResponse.json(
      { error: 'Failed to contact Kurs Pajak service' },
      { status: 502 }
    )
  }
}

async function safeParseError(response: Response): Promise<string | null> {
  try {
    const data = await response.json()
    if (typeof data?.detail === 'string') {
      return data.detail
    }
    if (typeof data?.error === 'string') {
      return data.error
    }
    return null
  } catch {
    return null
  }
}
