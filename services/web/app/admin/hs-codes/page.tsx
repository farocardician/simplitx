'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { FormEvent } from 'react';

import type { HsLevel, HsType } from '@/lib/hsCodes';

type LevelFilter = 'all' | HsLevel;
type TypeFilter = 'all' | HsType;

type HsStatus = 'active';

type HsCodeRow = {
  id: string;
  code: string;
  type: HsType;
  level: HsLevel;
  sectionCode: string;
  chapterCode: string;
  groupCode: string;
  descriptionEn: string;
  descriptionId: string;
  parentId: string | null;
  parentCode: string | null;
  createdAt: string;
  updatedAt: string;
  status: HsStatus;
};

type Breadcrumb = {
  code: string;
  level: HsLevel;
  descriptionEn: string;
  type: HsType;
};

type HsCodeDetailResponse = {
  record: HsCodeRow;
  breadcrumbs: Breadcrumb[];
};

type ToastTone = 'success' | 'error' | 'info';

type ToastState = {
  id: number;
  message: string;
  tone: ToastTone;
};

const LEVEL_LABEL: Record<LevelFilter, string> = {
  all: 'All levels',
  HS2: 'HS2',
  HS4: 'HS4',
  HS6: 'HS6'
};

const TYPE_LABEL: Record<TypeFilter, string> = {
  all: 'All types',
  BARANG: 'Barang',
  JASA: 'Jasa'
};

function useDebouncedValue<T>(value: T, delay = 250) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function TypeBadge({ type }: { type: HsType }) {
  const label = type === 'BARANG' ? 'Barang' : 'Jasa';
  const palette = type === 'BARANG'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : 'bg-sky-50 text-sky-700 border-sky-200';
  return (
    <span className={cx('inline-flex items-center px-2.5 py-1 text-xs font-semibold rounded-full border', palette)}>
      {label}
    </span>
  );
}

function LevelBadge({ level }: { level: HsLevel }) {
  const palette = level === 'HS2'
    ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
    : level === 'HS4'
      ? 'bg-purple-50 text-purple-700 border-purple-200'
      : 'bg-blue-50 text-blue-700 border-blue-200';

  return (
    <span className={cx('inline-flex items-center px-2.5 py-1 text-xs font-semibold rounded-full border', palette)}>
      {level}
    </span>
  );
}

function highlight(text: string, term: string) {
  if (!term) return text;
  const index = text.toLowerCase().indexOf(term.toLowerCase());
  if (index === -1) return text;
  return (
    <span>
      {text.slice(0, index)}
      <mark className="bg-amber-200 text-amber-900 px-1 py-0.5 rounded font-medium">
        {text.slice(index, index + term.length)}
      </mark>
      {text.slice(index + term.length)}
    </span>
  );
}

export default function HsCodeManagerPage() {
  const searchParams = useSearchParams();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [items, setItems] = useState<HsCodeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerData, setDrawerData] = useState<HsCodeDetailResponse | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [toastQueue, setToastQueue] = useState<ToastState[]>([]);
  const [isCreateOpen, setCreateOpen] = useState(false);

  const debouncedSearch = useDebouncedValue(search);

  const selectedRow = useMemo(() => items.find(item => item.id === selectedId) ?? null, [items, selectedId]);

  // Initialize search from URL parameter
  useEffect(() => {
    const searchParam = searchParams?.get('search');
    if (searchParam) {
      setSearch(searchParam);
    }
  }, [searchParams]);

  useEffect(() => {
    const cached = typeof window !== 'undefined' ? window.localStorage.getItem('hs-code-filters') : null;
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as { type?: TypeFilter; level?: LevelFilter };
        if (parsed.type) setTypeFilter(parsed.type);
        if (parsed.level) setLevelFilter(parsed.level);
      } catch (error) {
        console.warn('Failed to restore HS filter cache', error);
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('hs-code-filters', JSON.stringify({ type: typeFilter, level: levelFilter }));
  }, [typeFilter, levelFilter]);

  const showToast = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = Date.now();
    setToastQueue(prev => [...prev, { id, message, tone }]);
    const ttl = tone === 'error' ? 7000 : tone === 'success' ? 4000 : 3500;
    setTimeout(() => {
      setToastQueue(prev => prev.filter(toast => toast.id !== id));
    }, ttl);
  }, []);

  const fetchList = useCallback(async (cursor?: string, append = false) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (typeFilter !== 'all') params.set('type', typeFilter);
      if (levelFilter !== 'all') params.set('level', levelFilter);
      if (debouncedSearch) params.set('search', debouncedSearch.trim());
      if (cursor) params.set('cursor', cursor);

      const response = await fetch(`/api/hs-codes?${params.toString()}`, { cache: 'no-store' });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || 'Failed to load HS codes');
      }

      const payload = await response.json();
      const newItems: HsCodeRow[] = payload.items ?? [];
      setItems(prev => (append ? [...prev, ...newItems] : newItems));
      setNextCursor(payload.nextCursor ?? null);

      if (!append && newItems.length) {
        setSelectedId(newItems[0].id);
      }
    } catch (error: any) {
      console.error('Failed to load HS codes', error);
      setItems([]);
      setNextCursor(null);
      showToast(error.message || 'Failed to load HS codes', 'error');
    } finally {
      setLoading(false);
    }
  }, [typeFilter, levelFilter, debouncedSearch, showToast]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const handleLoadMore = useCallback(() => {
    if (!nextCursor || loading) return;
    fetchList(nextCursor, true);
  }, [fetchList, nextCursor, loading]);

  const loadDetails = useCallback(async (row: HsCodeRow) => {
    setDrawerLoading(true);
    setDrawerError(null);
    try {
      const response = await fetch(`/api/hs-codes/${row.code}?type=${row.type}`, { cache: 'no-store' });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || 'Failed to load HS code');
      }
      const payload = await response.json();
      setDrawerData(payload);
    } catch (error: any) {
      console.error('Failed to load HS code detail', error);
      setDrawerError(error.message || 'Failed to load HS code');
    } finally {
      setDrawerLoading(false);
    }
  }, []);

  const handleSelect = useCallback((row: HsCodeRow) => {
    setSelectedId(row.id);
    loadDetails(row);
  }, [loadDetails]);

  useEffect(() => {
    if (items.length && !selectedId) {
      handleSelect(items[0]);
    }
  }, [items, selectedId, handleSelect]);

  const handleSaveDetail = useCallback(async (changes: Partial<Pick<HsCodeRow, 'descriptionEn' | 'descriptionId'>>) => {
    if (!selectedRow) return;
    setDrawerLoading(true);
    try {
      const response = await fetch(`/api/hs-codes/${selectedRow.code}?type=${selectedRow.type}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...changes, updatedAt: drawerData?.record.updatedAt })
      });

      if (response.status === 409) {
        const payload = await response.json();
        setDrawerError(payload?.error?.message || 'Record changed elsewhere.');
        showToast(payload?.error?.message || 'Record changed elsewhere. Refresh to continue.', 'info');
        return;
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || 'Failed to save changes');
      }

      const updated = await response.json();
      setDrawerData(prev => (prev ? { ...prev, record: { ...prev.record, ...updated } } : prev));
      setItems(prev => prev.map(item => (item.id === selectedRow.id ? { ...item, ...updated } : item)));
      showToast('HS code updated', 'success');
    } catch (error: any) {
      console.error('Failed to save HS code changes', error);
      setDrawerError(error.message || 'Failed to save changes');
      showToast(error.message || 'Failed to save changes', 'error');
    } finally {
      setDrawerLoading(false);
    }
  }, [selectedRow, drawerData, showToast]);

  const handleCreated = useCallback((row: HsCodeRow) => {
    setCreateOpen(false);
    showToast('HS code imported successfully', 'success');
    // Reload list focused on created code
    fetchList().then(() => {
      setSelectedId(row.id);
    });
  }, [fetchList, showToast]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white/90 backdrop-blur sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-6 py-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-slate-900">HS Code Management</h1>
              <p className="text-sm text-slate-600 mt-1">Browse and maintain the official Barang &amp; Jasa catalogue.</p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => fetchList()}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg border border-slate-200 transition"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 014.582 9M20 20v-5h-.581m-15.357-2a8.003 8.003 0 0015.357 2" />
                </svg>
                Refresh
              </button>
              <button
                onClick={() => setCreateOpen(true)}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm transition"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Import from CSV
              </button>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-4">
            <div className="relative">
              <input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search by code or description…"
                className="w-full pl-10 pr-4 py-2.5 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-200 focus:border-blue-500 bg-white shadow-sm"
              />
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M10 18a8 8 0 100-16 8 8 0 000 16z" />
              </svg>
            </div>

            <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-1.5 shadow-sm">
              {(['all', 'BARANG', 'JASA'] as TypeFilter[]).map(option => (
                <button
                  key={option}
                  onClick={() => setTypeFilter(option)}
                  className={cx(
                    'px-2.5 py-1.5 text-xs font-semibold rounded-md transition',
                    typeFilter === option ? 'bg-blue-600 text-white shadow' : 'text-slate-600 hover:bg-slate-100'
                  )}
                >
                  {TYPE_LABEL[option]}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-1.5 shadow-sm">
              {(['all', 'HS2', 'HS4', 'HS6'] as LevelFilter[]).map(option => (
                <button
                  key={option}
                  onClick={() => setLevelFilter(option)}
                  className={cx(
                    'px-2.5 py-1.5 text-xs font-semibold rounded-md transition',
                    levelFilter === option ? 'bg-slate-900 text-white shadow' : 'text-slate-600 hover:bg-slate-100'
                  )}
                >
                  {LEVEL_LABEL[option]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6">
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50">
            <p className="text-sm text-slate-600">
              {loading ? 'Loading…' : `${items.length.toLocaleString()} results`}
            </p>
            {nextCursor && (
              <button
                onClick={handleLoadMore}
                className="text-sm font-semibold text-blue-600 hover:text-blue-700"
                disabled={loading}
              >
                Load more
              </button>
            )}
          </div>

          <div className="max-h-[70vh] overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-white border-b border-slate-200 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Level</th>
                  <th className="px-4 py-3">English Description</th>
                  <th className="px-4 py-3">Indonesian Description</th>
                  <th className="px-4 py-3">Parent</th>
                </tr>
              </thead>
              <tbody>
                {!loading && items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-500">
                      No HS codes match your filters.
                    </td>
                  </tr>
                )}

                {items.map(row => {
                  const isActive = row.id === selectedId;
                  const digitsTerm = /^(\d+)$/.test(debouncedSearch.trim()) ? debouncedSearch.trim() : '';
                  const textTerm = digitsTerm ? '' : debouncedSearch.trim();
                  return (
                    <tr
                      key={row.id}
                      onClick={() => handleSelect(row)}
                      className={cx(
                        'cursor-pointer border-b border-slate-100 transition-colors',
                        isActive ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                      )}
                    >
                      <td className="px-4 py-3 font-mono text-[13px] font-semibold text-slate-900">
                        {digitsTerm ? highlight(row.code, digitsTerm) : row.code}
                      </td>
                      <td className="px-4 py-3">
                        <TypeBadge type={row.type} />
                      </td>
                      <td className="px-4 py-3">
                        <LevelBadge level={row.level} />
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {textTerm ? highlight(row.descriptionEn, textTerm) : row.descriptionEn}
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {textTerm ? highlight(row.descriptionId, textTerm) : row.descriptionId}
                      </td>
                      <td className="px-4 py-3">
                        {row.parentCode ? (
                          <span className="font-mono text-xs text-slate-600 bg-slate-100 border border-slate-200 px-2 py-1 rounded-md">
                            {row.parentCode}
                          </span>
                        ) : (
                          <span className="text-slate-400 text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden min-h-[420px]">
          <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
            <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">Details</h2>
            {selectedRow && (
              <div className="mt-2 flex items-center gap-3">
                <span className="font-mono text-lg font-semibold text-slate-900">{selectedRow.code}</span>
                <TypeBadge type={selectedRow.type} />
                <LevelBadge level={selectedRow.level} />
              </div>
            )}
          </div>

          <div className="px-5 py-4 space-y-4">
            {drawerLoading && (
              <div className="py-10 text-center text-sm text-slate-500">Loading details…</div>
            )}

            {drawerError && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {drawerError}
              </div>
            )}

            {drawerData && !drawerLoading && !drawerError && (
              <DetailPanel
                data={drawerData}
                onSave={handleSaveDetail}
              />
            )}

            {!selectedRow && !loading && (
              <p className="text-sm text-slate-500">Select a code to view its metadata and descriptions.</p>
            )}
          </div>
        </aside>
      </main>

      {toastQueue.length > 0 && (
        <div className="fixed bottom-6 right-6 space-y-3 z-50">
          {toastQueue.map(toast => (
            <div
              key={toast.id}
              className={cx(
                'px-4 py-3 rounded-lg shadow-lg text-white text-sm font-medium flex items-center gap-3',
                toast.tone === 'success' && 'bg-emerald-500',
                toast.tone === 'error' && 'bg-red-500',
                toast.tone === 'info' && 'bg-blue-500'
              )}
            >
              {toast.message}
            </div>
          ))}
        </div>
      )}

      {isCreateOpen && (
        <CreateHsCodeDialog
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
          onError={message => showToast(message, 'error')}
        />
      )}
    </div>
  );
}

function DetailPanel({ data, onSave }: { data: HsCodeDetailResponse; onSave: (changes: Partial<Pick<HsCodeRow, 'descriptionEn' | 'descriptionId'>>) => Promise<void>; }) {
  const { record, breadcrumbs } = data;
  const [descriptionEn, setDescriptionEn] = useState(record.descriptionEn);
  const [descriptionId, setDescriptionId] = useState(record.descriptionId);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDescriptionEn(record.descriptionEn);
    setDescriptionId(record.descriptionId);
  }, [record.descriptionEn, record.descriptionId]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!descriptionEn.trim() || !descriptionId.trim()) return;
    setSaving(true);
    try {
      await onSave({ descriptionEn: descriptionEn.trim(), descriptionId: descriptionId.trim() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2 text-sm text-slate-600">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-700">Section</span>
          <span className="font-mono text-xs bg-slate-100 px-2 py-1 rounded border border-slate-200">{record.sectionCode}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-700">Chapter</span>
          <span className="font-mono text-xs bg-slate-100 px-2 py-1 rounded border border-slate-200">{record.chapterCode}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-700">Group</span>
          <span className="font-mono text-xs bg-slate-100 px-2 py-1 rounded border border-slate-200">{record.groupCode}</span>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">English Description</label>
        <textarea
          value={descriptionEn}
          onChange={event => setDescriptionEn(event.target.value)}
          rows={4}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
        />
      </div>

      <div className="space-y-2">
        <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Indonesian Description</label>
        <textarea
          value={descriptionId}
          onChange={event => setDescriptionId(event.target.value)}
          rows={4}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
        />
      </div>

      <button
        type="submit"
        className="w-full flex justify-center items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm disabled:bg-blue-300"
        disabled={saving}
      >
        {saving ? 'Saving…' : 'Save changes'}
      </button>

      <div className="space-y-2 text-xs text-slate-500 border-t border-slate-200 pt-3">
        <div>Updated: {formatDate(record.updatedAt)}</div>
        <div>Created: {formatDate(record.createdAt)}</div>
      </div>

      {breadcrumbs.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Hierarchy</h3>
          <ul className="space-y-1">
            {breadcrumbs.map(crumb => (
              <li key={`${crumb.type}-${crumb.code}`} className="flex items-center gap-2 text-xs text-slate-600">
                <span className="font-mono text-[11px] font-semibold text-slate-800">{crumb.code}</span>
                <LevelBadge level={crumb.level} />
                <span className="truncate">{crumb.descriptionEn}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}

function CreateHsCodeDialog({ onClose, onCreated, onError }: { onClose: () => void; onCreated: (row: HsCodeRow) => void; onError: (message: string) => void; }) {
  const [type, setType] = useState<HsType>('BARANG');
  const [code, setCode] = useState('');
  const [english, setEnglish] = useState('');
  const [indonesian, setIndonesian] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || !english.trim() || !indonesian.trim()) {
      onError('All fields are required.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/hs-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, type, descriptionEn: english.trim(), descriptionId: indonesian.trim() })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || 'Failed to import HS code');
      }

      const created = await response.json();
      onCreated(created);
    } catch (error: any) {
      console.error('Failed to create HS code', error);
      onError(error.message || 'Failed to import HS code');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur">
      <div className="w-full max-w-lg bg-white rounded-xl shadow-2xl border border-slate-200 p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Import HS code</h3>
            <p className="text-sm text-slate-600">Quickly import an entry from the official CSV set.</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Type</label>
            <div className="flex gap-2">
              {(['BARANG', 'JASA'] as HsType[]).map(option => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setType(option)}
                  className={cx(
                    'flex-1 px-3 py-2 text-sm font-semibold rounded-lg border transition',
                    type === option ? 'bg-blue-600 text-white border-blue-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  )}
                >
                  {TYPE_LABEL[option]}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Code</label>
            <input
              value={code}
              onChange={event => setCode(event.target.value)}
              placeholder="e.g. 0101"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
            <p className="text-xs text-slate-500">Provide 2, 4, or 6 digits. We will normalize to 6 digits automatically.</p>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">English Description</label>
            <textarea
              value={english}
              onChange={event => setEnglish(event.target.value)}
              rows={3}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Indonesian Description</label>
            <textarea
              value={indonesian}
              onChange={event => setIndonesian(event.target.value)}
              rows={3}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-semibold text-slate-600 hover:text-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm disabled:bg-blue-300"
              disabled={submitting}
            >
              {submitting ? 'Importing…' : 'Import'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
