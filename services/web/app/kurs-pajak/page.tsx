'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'

type Rate = {
  iso_code: string
  unit: number
  value_idr: string
  per_unit_idr: string
  source: string | null
}

type PeriodPayload = {
  week_start: string
  week_end: string
  kmk_number: string
  kmk_url: string
  source_url: string
  published_at: string | null
  rates: Rate[]
}

const idFormatter = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 2,
})

const numberFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
})

function getDisplayNames() {
  try {
    if (typeof Intl.DisplayNames === 'undefined') {
      return null
    }
    return new Intl.DisplayNames(['en'], { type: 'currency' })
  } catch {
    return null
  }
}

export default function KursPajakPage() {
  const [period, setPeriod] = useState<PeriodPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [scraping, setScraping] = useState(false)

  const [selectedCurrency, setSelectedCurrency] = useState('USD')
  const [foreignAmount, setForeignAmount] = useState('1')
  const [idrAmount, setIdrAmount] = useState('1000000')
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedDate, setSelectedDate] = useState('')

  const displayNames = useMemo(() => getDisplayNames(), [])

  const loadData = useCallback(async (date?: string) => {
    setLoading(true)
    setError(null)
    try {
      const url = date ? `/api/kurs/latest?date=${date}` : '/api/kurs/latest'
      const response = await fetch(url, {
        cache: 'no-store',
      })

      if (!response.ok) {
        const data = await response.json().catch(() => null)
        const message = data?.error || 'Failed to load Kurs Pajak data'
        throw new Error(message)
      }

      const payload: PeriodPayload = await response.json()
      setPeriod(payload)
      setError(null)
    } catch (err) {
      setError((err as Error).message || 'Unable to load data')
      setPeriod(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    if (!period || period.rates.length === 0) {
      return
    }

    const currentExists = period.rates.some((rate) => rate.iso_code === selectedCurrency)
    if (!currentExists) {
      const fallback =
        period.rates.find((rate) => rate.iso_code === 'USD') || period.rates[0]
      setSelectedCurrency(fallback.iso_code)
    }
  }, [period, selectedCurrency])

  const handleFetchLatest = async () => {
    setScraping(true)
    setError(null)
    try {
      const response = await fetch('/api/kurs/scrape', {
        method: 'POST',
      })

      if (!response.ok) {
        const data = await response.json().catch(() => null)
        const message = data?.error || 'Failed to scrape latest data'
        throw new Error(message)
      }

      // After successful scrape, reload the data
      await loadData()
    } catch (err) {
      setError((err as Error).message || 'Failed to fetch latest data')
    } finally {
      setScraping(false)
    }
  }

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const date = e.target.value
    setSelectedDate(date)
    if (date) {
      loadData(date)
    } else {
      loadData()
    }
  }

  const rates = useMemo(() => period?.rates ?? [], [period])

  const ratesMap = useMemo(() => {
    const map = new Map<string, Rate>()
    for (const rate of rates) {
      map.set(rate.iso_code, rate)
    }
    return map
  }, [rates])

  const selectedRate = ratesMap.get(selectedCurrency)

  const perUnitValue = selectedRate ? parseFloat(selectedRate.per_unit_idr) : 0
  const officialValue = selectedRate ? parseFloat(selectedRate.value_idr) : 0
  const officialUnit = selectedRate?.unit ?? 1

  const safeForeignAmount = Math.max(parseFloat(foreignAmount || '0') || 0, 0)
  const safeIdrAmount = Math.max(parseFloat(idrAmount || '0') || 0, 0)

  const convertedIdr = perUnitValue * safeForeignAmount
  const convertedForeign = perUnitValue > 0 ? safeIdrAmount / perUnitValue : 0

  const filteredRates = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) {
      return rates
    }
    return rates.filter((rate) => {
      const name = displayNames?.of(rate.iso_code)?.toLowerCase() || ''
      return (
        rate.iso_code.toLowerCase().includes(term) ||
        name.includes(term)
      )
    })
  }, [rates, searchTerm, displayNames])

  const renderCurrencyLabel = (iso: string) => {
    const label = displayNames?.of(iso)
    return label ? `${iso} • ${label}` : iso
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-gradient-to-r from-indigo-600 via-purple-600 to-sky-500 text-white">
        <div className="mx-auto max-w-5xl px-4 py-16">
          <div className="space-y-4">
            <p className="text-sm font-semibold uppercase tracking-wide text-white/80">
              Kurs Pajak Resmi
            </p>
            <h1 className="text-4xl font-bold leading-tight sm:text-5xl">
              Weekly Exchange Rates, Always Up to Date
            </h1>
            <p className="max-w-3xl text-base text-white/90 sm:text-lg">
              Explore the latest Indonesian Ministry of Finance reference exchange rates.
              Convert foreign currencies to IDR (and back) with live values sourced from the
              weekly Kurs Pajak bulletin.
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-16">
        <section className="-mt-12 space-y-6">
          {/* Action Bar */}
          <div className="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-xl ring-1 ring-black/5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
              <button
                onClick={handleFetchLatest}
                disabled={scraping || loading}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {scraping ? (
                  <>
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Fetching...
                  </>
                ) : (
                  <>
                    <span>🔄</span>
                    Fetch Latest Data
                  </>
                )}
              </button>

              <div className="flex items-center gap-2">
                <label htmlFor="date-picker" className="text-sm font-medium text-slate-700 whitespace-nowrap">
                  View rate for:
                </label>
                <input
                  id="date-picker"
                  type="date"
                  value={selectedDate}
                  onChange={handleDateChange}
                  max={new Date().toISOString().split('T')[0]}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-100"
                />
                {selectedDate && (
                  <button
                    onClick={() => {
                      setSelectedDate('')
                      loadData()
                    }}
                    className="text-sm text-slate-600 hover:text-slate-900"
                    title="Clear date"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
            {scraping && (
              <p className="text-sm text-slate-600">
                Scraping latest data from fiskal.kemenkeu.go.id...
              </p>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
            <div className="rounded-2xl bg-white p-6 shadow-xl ring-1 ring-black/5">
              {loading && !period ? (
                <div className="space-y-4 animate-pulse">
                  <div className="h-4 w-2/3 rounded bg-slate-200" />
                  <div className="h-6 w-1/2 rounded bg-slate-200" />
                  <div className="h-4 w-3/4 rounded bg-slate-200" />
                  <div className="h-4 w-5/6 rounded bg-slate-200" />
                </div>
              ) : error ? (
                <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
                  <p className="font-medium">{error}</p>
                  <p className="mt-1">
                    Try clicking "Fetch Latest Data" to load current exchange rates.
                  </p>
                </div>
              ) : period ? (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-2xl font-semibold text-slate-900">
                      {renderPeriodRange(period.week_start, period.week_end)}
                    </h2>
                    <p className="text-sm text-slate-600">
                      Effective Wednesday through Tuesday (Asia/Jakarta)
                    </p>
                  </div>

                  <dl className="grid gap-4 sm:grid-cols-2">
                    <div className="rounded-lg border border-slate-200 p-4">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Keputusan Menteri Keuangan
                      </dt>
                      <dd className="mt-2 space-y-1 text-sm text-slate-700">
                        <p className="font-medium">{period.kmk_number}</p>
                        <Link
                          href={period.kmk_url}
                          className="inline-flex items-center gap-1 text-indigo-600 transition hover:text-indigo-500"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Lihat dokumen PDF
                          <span aria-hidden="true">↗</span>
                        </Link>
                      </dd>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-4">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Diterbitkan
                      </dt>
                      <dd className="mt-2 text-sm text-slate-700">
                        <p className="font-medium">
                          {period.published_at ? formatDate(period.published_at) : 'Tidak tersedia'}
                        </p>
                        <p className="text-xs text-slate-500">
                          Sumber: fiskal.kemenkeu.go.id
                        </p>
                      </dd>
                    </div>
                  </dl>

                  {selectedRate && (
                    <div className="rounded-xl bg-indigo-50 p-4 text-sm text-indigo-900">
                      <p className="font-semibold">Highlighted currency</p>
                      <p className="mt-1">
                        1 {selectedCurrency} = {idFormatter.format(perUnitValue)}
                      </p>
                      {officialUnit > 1 && (
                        <p className="mt-1 text-xs text-indigo-800">
                          Official bulletin value: {idFormatter.format(officialValue)} per {officialUnit} {selectedCurrency}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3 text-sm text-slate-600">
                  <p>No Kurs Pajak data available.</p>
                  <p>Click "Fetch Latest Data" to load current exchange rates.</p>
                </div>
              )}
            </div>

            <div className="rounded-2xl bg-white p-6 shadow-lg ring-1 ring-black/5">
              <h2 className="text-lg font-semibold text-slate-900">
                Quick currency converter
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Choose a currency and enter an amount to convert between foreign currency and IDR.
              </p>

              <div className="mt-6 space-y-6">
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-slate-700" htmlFor="currency">
                    Currency
                  </label>
                  <select
                    id="currency"
                    value={selectedCurrency}
                    onChange={(event) => setSelectedCurrency(event.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-100"
                    aria-label="Select currency"
                    disabled={loading || !period}
                  >
                    {rates.map((rate) => (
                      <option key={rate.iso_code} value={rate.iso_code}>
                        {renderCurrencyLabel(rate.iso_code)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="block text-sm font-medium text-slate-700" htmlFor="foreignAmount">
                      Amount in {selectedCurrency}
                    </label>
                    <input
                      id="foreignAmount"
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      value={foreignAmount}
                      onChange={(event) => setForeignAmount(event.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-100"
                    />
                    <p className="text-xs text-slate-500">
                      Result: {perUnitValue ? idFormatter.format(convertedIdr) : '—'}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <label className="block text-sm font-medium text-slate-700" htmlFor="idrAmount">
                      Amount in IDR
                    </label>
                    <input
                      id="idrAmount"
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="1000"
                      value={idrAmount}
                      onChange={(event) => setIdrAmount(event.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-100"
                    />
                    <p className="text-xs text-slate-500">
                      Result: {perUnitValue ? `${numberFormatter.format(convertedForeign)} ${selectedCurrency}` : '—'}
                    </p>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                  Conversions use the latest Kurs Pajak reference rate (per 1 {selectedCurrency}).
                  Official publications may quote{' '}
                  {officialUnit > 1 ? `per ${officialUnit} units` : 'per multiple units'}; values above are normalised.
                </div>
              </div>
            </div>
          </div>

          <section className="rounded-2xl bg-white shadow-xl ring-1 ring-black/5">
            <div className="flex flex-col gap-4 border-b border-slate-200 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">
                  All currencies in this bulletin
                </h3>
                <p className="text-sm text-slate-600">
                  Search by ISO code or currency name. Rates are per 1 unit for easy comparison.
                </p>
              </div>
              <div className="w-full sm:w-64">
                <label htmlFor="search" className="sr-only">
                  Search currency
                </label>
                <div className="relative">
                  <input
                    id="search"
                    type="search"
                    placeholder="Search currency"
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 pl-9 text-sm shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-100"
                  />
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">
                    🔍
                  </span>
                </div>
              </div>
            </div>

            <div className="max-h-[520px] overflow-y-auto">
              <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-6 py-3">Currency</th>
                    <th scope="col" className="px-6 py-3">Unit</th>
                    <th scope="col" className="px-6 py-3">Official value</th>
                    <th scope="col" className="px-6 py-3">Per 1 unit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loading && rates.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-6 py-6 text-center text-sm text-slate-500">
                        Loading data…
                      </td>
                    </tr>
                  ) : filteredRates.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-6 py-6 text-center text-sm text-slate-500">
                        {period ? 'No currencies match your search.' : 'No data available. Click "Fetch Latest Data" to load.'}
                      </td>
                    </tr>
                  ) : (
                    filteredRates.map((rate) => {
                      const perUnit = parseFloat(rate.per_unit_idr)
                      const official = parseFloat(rate.value_idr)
                      return (
                        <tr key={rate.iso_code} className="hover:bg-slate-50">
                          <td className="px-6 py-3 font-medium text-slate-900">
                            <div className="flex flex-col">
                              <span>{rate.iso_code}</span>
                              <span className="text-xs text-slate-500">
                                {displayNames?.of(rate.iso_code) || '—'}
                              </span>
                            </div>
                          </td>
                          <td className="px-6 py-3 text-slate-700">{rate.unit}</td>
                          <td className="px-6 py-3 text-slate-700">
                            {idFormatter.format(official)}
                          </td>
                          <td className="px-6 py-3 text-slate-900">
                            {idFormatter.format(perUnit)}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-200 px-6 py-4 text-xs text-slate-500">
              Data sourced from the latest Kurs Pajak publication. Rates refreshed automatically when new bulletins are published.
            </div>
          </section>
        </section>
      </main>
    </div>
  )
}

function formatDate(value: string) {
  try {
    const date = new Date(value)
    return new Intl.DateTimeFormat('id-ID', {
      dateStyle: 'long',
      timeZone: 'Asia/Jakarta',
    }).format(date)
  } catch {
    return value
  }
}

function renderPeriodRange(start: string, end: string) {
  const startDate = new Date(start)
  const endDate = new Date(end)
  return `${formatRangePart(startDate)} – ${formatRangePart(endDate)}`
}

function formatRangePart(date: Date) {
  return new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Jakarta',
  }).format(date)
}
