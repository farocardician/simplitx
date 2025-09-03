import { NextResponse } from 'next/server'

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://gateway:8002'

export async function GET() {
  try {
    const response = await fetch(`${GATEWAY_URL}/pdf2json/templates`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch templates from gateway' },
        { status: response.status }
      )
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch (error) {
    console.error('Error fetching templates:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}