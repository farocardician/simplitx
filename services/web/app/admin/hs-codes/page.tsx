'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HsLevel } from '@/lib/hsCodes';

type HsStatus = 'active' | 'expired';
type LevelFilter = 'all' | 'HS2' | 'HS4' | 'HS6';
type StatusFilter = 'active' | 'expired' | 'all';

interface HsCodeRow {
  id: string;
  code: string;
  level: HsLevel;
  jurisdiction: string;
  versionYear: number;
  parentCode: string | null;
  descriptionEn: string;
  descriptionId: string;
  notes?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  createdAt: string;
  updatedAt: string;
  status: HsStatus;
}

interface HsCodeDetailResponse {
  record: HsCodeRow;
  breadcrumbs: Array<{ code: string; level: string; descriptionEn: string }>;
}

interface ToastState {
  id: number;
  message: string;
  tone: 'success' | 'error' | 'info';
}

interface RecentItem {
  code: string;
  description: string;
  updatedAt: string;
}

const LOCAL_FILTER_KEY = 'hs-code-manager-filters';
const LOCAL_RECENTS_KEY = 'hs-code-manager-recents';

const LEVEL_LABELS: Record<LevelFilter, string> = {
  all: 'All Levels',
  HS2: 'HS2 Only',
  HS4: 'HS4 Only',
  HS6: 'HS6 Only'
};

const STATUS_LABELS: Record<StatusFilter, string> = {
  active: 'Active',
  expired: 'Expired',
  all: 'All Status'
};

const DEFAULT_JURISDICTIONS = ['ID'];
const DEFAULT_VERSIONS = [2022, 2023];

function cx(...classes: Array<string | null | undefined | false>) {
  return classes.filter(Boolean).join(' ');
}

function formatDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function highlightMatch(text: string, term: string) {
  if (!term) return text;
  const lower = term.toLowerCase();
  const index = text.toLowerCase().indexOf(lower);
  if (index === -1) return text;
  return (
    <span>
      {text.slice(0, index)}
      <mark className="bg-amber-200 text-amber-900 px-1 py-0.5 rounded font-medium">{text.slice(index, index + term.length)}</mark>
      {text.slice(index + term.length)}
    </span>
  );
}

function buildStatusBadge(status: HsStatus) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-emerald-50 text-emerald-700 rounded-full border border-emerald-200">
        <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 8 8">
          <circle cx="4" cy="4" r="3" />
        </svg>
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-gray-100 text-gray-600 rounded-full border border-gray-300">
      <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 8 8">
        <circle cx="4" cy="4" r="3" />
      </svg>
      Expired
    </span>
  );
}

function getLevelColor(level: HsLevel) {
  switch (level) {
    case 'HS2':
      return 'bg-blue-50 text-blue-700 border-blue-200';
    case 'HS4':
      return 'bg-purple-50 text-purple-700 border-purple-200';
    case 'HS6':
      return 'bg-indigo-50 text-indigo-700 border-indigo-200';
    default:
      return 'bg-gray-50 text-gray-700 border-gray-200';
  }
}

export default function HsCodeManagerPage() {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const tableEndRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);

  const [jurisdiction, setJurisdiction] = useState<string>('ID');
  const [versionYear, setVersionYear] = useState<number>(2022);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [items, setItems] = useState<HsCodeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerCode, setDrawerCode] = useState<string | null>(null);
  const [drawerData, setDrawerData] = useState<HsCodeDetailResponse | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [drawerSaving, setDrawerSaving] = useState(false);
  const [showExplain, setShowExplain] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [toastQueue, setToastQueue] = useState<ToastState[]>([]);
  const [recents, setRecents] = useState<RecentItem[]>([]);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 220);
    return () => clearTimeout(timer);
  }, [search]);

  // Persist filters to local storage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(LOCAL_FILTER_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed.jurisdiction) setJurisdiction(parsed.jurisdiction);
        if (parsed.versionYear) setVersionYear(parsed.versionYear);
        if (parsed.level) setLevelFilter(parsed.level);
        if (parsed.status) setStatusFilter(parsed.status);
      } catch (err) {
        console.warn('Failed to parse HS filter cache', err);
      }
    }
    const recentsCache = window.localStorage.getItem(LOCAL_RECENTS_KEY);
    if (recentsCache) {
      try {
        const parsedRecents = JSON.parse(recentsCache) as RecentItem[];
        setRecents(parsedRecents.slice(0, 10));
      } catch (err) {
        console.warn('Failed to parse HS recents cache', err);
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LOCAL_FILTER_KEY, JSON.stringify({
      jurisdiction,
      versionYear,
      level: levelFilter,
      status: statusFilter
    }));
  }, [jurisdiction, versionYear, levelFilter, statusFilter]);

  // Fetch data when dependencies change
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          jurisdiction,
          versionYear: String(versionYear),
          level: levelFilter,
          status: statusFilter,
          limit: '50'
        });
        if (debouncedSearch) params.append('search', debouncedSearch);

        const response = await fetch(`/api/hs-codes?${params.toString()}`, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Failed to load HS codes (${response.status})`);
        }

        const payload = await response.json();
        if (cancelled) return;

        setItems(payload.items || []);
        setNextCursor(payload.nextCursor ?? null);
        setSelectedIndex(payload.items?.length ? 0 : null);
        loadingMoreRef.current = false;
      } catch (error: any) {
        console.error(error);
        showToast(error.message || 'Failed to load HS codes', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, levelFilter, statusFilter, jurisdiction, versionYear]);

  // Intersection Observer for infinite scroll
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first.isIntersecting && nextCursor && !loading && !loadingMoreRef.current) {
          loadMore();
        }
      },
      { threshold: 0.1 }
    );

    if (tableEndRef.current) {
      observer.observe(tableEndRef.current);
    }

    return () => {
      if (tableEndRef.current) {
        observer.unobserve(tableEndRef.current);
      }
    };
  }, [nextCursor, loading]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.target as HTMLElement)?.tagName === 'INPUT' || (event.target as HTMLElement)?.tagName === 'TEXTAREA') {
        return;
      }

      if ((event.altKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (!items.length) return;

      switch (event.key) {
        case 'ArrowDown': {
          event.preventDefault();
          setSelectedIndex(prev => {
            const next = prev === null ? 0 : Math.min(items.length - 1, prev + 1);
            return next;
          });
          break;
        }
        case 'ArrowUp': {
          event.preventDefault();
          setSelectedIndex(prev => {
            const next = prev === null ? 0 : Math.max(0, prev - 1);
            return next;
          });
          break;
        }
        case 'Enter':
        case 'ArrowRight': {
          event.preventDefault();
          if (selectedIndex !== null) {
            openDrawer(items[selectedIndex]);
          }
          break;
        }
        case 'Escape': {
          if (drawerOpen) {
            setDrawerOpen(false);
            setDrawerCode(null);
          }
          break;
        }
        case 'a':
        case 'A': {
          event.preventDefault();
          setCreateModalOpen(true);
          break;
        }
        case '1':
          setLevelFilter('all');
          break;
        case '2':
          setLevelFilter('HS2');
          break;
        case '3':
          setLevelFilter('HS4');
          break;
        case '4':
          setLevelFilter('HS6');
          break;
        default:
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [items, selectedIndex, drawerOpen]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMoreRef.current) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);

    try {
      const params = new URLSearchParams({
        jurisdiction,
        versionYear: String(versionYear),
        level: levelFilter,
        status: statusFilter,
        limit: '50',
        cursor: nextCursor
      });
      if (debouncedSearch) params.append('search', debouncedSearch);

      const response = await fetch(`/api/hs-codes?${params.toString()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Failed to load more HS codes');

      const payload = await response.json();
      setItems(prev => [...prev, ...(payload.items || [])]);
      setNextCursor(payload.nextCursor ?? null);
    } catch (error: any) {
      console.error(error);
      showToast(error.message || 'Failed to load more HS codes', 'error');
    } finally {
      setLoadingMore(false);
      loadingMoreRef.current = false;
    }
  }, [nextCursor, jurisdiction, versionYear, levelFilter, statusFilter, debouncedSearch]);

  function addRecent(recent: RecentItem) {
    setRecents(prev => {
      const filtered = prev.filter(item => item.code !== recent.code);
      const next = [recent, ...filtered].slice(0, 10);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(LOCAL_RECENTS_KEY, JSON.stringify(next));
      }
      return next;
    });
  }

  const dismissToast = useCallback((id: number) => {
    setToastQueue(prev => prev.filter(toast => toast.id !== id));
  }, []);

  function showToast(message: string, tone: ToastState['tone']) {
    const id = Date.now();
    setToastQueue(prev => [...prev, { id, message, tone }]);
    const ttl = tone === 'error' ? 6000 : 3500;
    setTimeout(() => dismissToast(id), ttl);
  }

  function openDrawer(row: HsCodeRow) {
    setDrawerOpen(true);
    setDrawerCode(row.code);
    setDrawerLoading(true);
    setDrawerError(null);
    setShowExplain(false);

    fetch(`/api/hs-codes/${row.code}?jurisdiction=${jurisdiction}&versionYear=${versionYear}`, { cache: 'no-store' })
      .then(async response => {
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error?.message || 'Failed to load details');
        }
        return response.json();
      })
      .then((payload: HsCodeDetailResponse) => {
        setDrawerData(payload);
      })
      .catch(error => {
        console.error(error);
        setDrawerError(error.message);
      })
      .finally(() => setDrawerLoading(false));
  }

  async function saveDrawerChanges(changes: Partial<HsCodeRow>) {
    if (!drawerCode || !drawerData) return;
    setDrawerSaving(true);
    try {
      const response = await fetch(`/api/hs-codes/${drawerCode}?jurisdiction=${jurisdiction}&versionYear=${versionYear}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...changes, updatedAt: drawerData.record.updatedAt })
      });

      if (response.status === 409) {
        const payload = await response.json();
        setDrawerError(payload?.error?.message || 'Updated elsewhere. Review changes?');
        showToast('Updated elsewhere. Review changes?', 'info');
        return;
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || 'Failed to save changes');
      }

      const updated = await response.json();
      setDrawerData(prev => prev ? { ...prev, record: { ...prev.record, ...updated } } : prev);
      setItems(prev => prev.map(item => (item.code === drawerCode ? { ...item, ...updated } : item)));
      addRecent({ code: drawerCode, description: updated.descriptionEn, updatedAt: updated.updatedAt });
      showToast('Successfully saved changes', 'success');
    } catch (error: any) {
      console.error(error);
      setDrawerError(error.message || 'Failed to save changes');
      showToast(error.message || 'Failed to save changes', 'error');
    } finally {
      setDrawerSaving(false);
    }
  }

  useEffect(() => {
    // Focus search on load
    searchInputRef.current?.focus();
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-slate-50 flex flex-col">
      {/* Modern Header */}
      <header className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-30 backdrop-blur-sm bg-white/95">
        <div className="max-w-[1400px] mx-auto px-6 py-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-slate-900 tracking-tight">HS Code Manager</h1>
              <p className="text-sm text-slate-600 mt-1 flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Manage and organize Harmonized System codes with keyboard shortcuts
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 px-3 py-2 bg-slate-100 rounded-lg border border-slate-200">
                <svg className="w-4 h-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <select
                  className="bg-transparent text-sm font-medium text-slate-700 focus:outline-none cursor-pointer"
                  value={jurisdiction}
                  onChange={event => setJurisdiction(event.target.value.toUpperCase())}
                >
                  {DEFAULT_JURISDICTIONS.map(code => (
                    <option key={code} value={code}>{code}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2 px-3 py-2 bg-slate-100 rounded-lg border border-slate-200">
                <svg className="w-4 h-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <select
                  className="bg-transparent text-sm font-medium text-slate-700 focus:outline-none cursor-pointer"
                  value={versionYear}
                  onChange={event => setVersionYear(Number(event.target.value))}
                >
                  {DEFAULT_VERSIONS.map(year => (
                    <option key={year} value={year}>{year}</option>
                  ))}
                </select>
              </div>
              <button
                onClick={() => setCreateModalOpen(true)}
                className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg shadow-sm hover:shadow-md transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add HS Code
              </button>
              <button
                onClick={() => setShowImportModal(true)}
                className="inline-flex items-center gap-2 border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-semibold px-5 py-2.5 rounded-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                Import
              </button>
              <button
                onClick={() => showToast('Keyboard shortcuts: ↑↓ navigate, Enter/→ details, A add, 1-4 filter', 'info')}
                className="p-2.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400"
                aria-label="Help"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Search and Filters Section */}
        <div className="bg-slate-50/50 border-t border-slate-100">
          <div className="max-w-[1400px] mx-auto px-6 py-4">
            <div className="flex items-center gap-4 mb-4">
              <div className="relative flex-1">
                <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  ref={searchInputRef}
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder="Search by code (e.g., 9405) or description (e.g., 'LED module')..."
                  className="w-full pl-12 pr-12 py-3.5 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent shadow-sm placeholder:text-slate-400"
                  aria-label="Search HS codes"
                />
                {(loading || loadingMore) && (
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 text-blue-500" aria-hidden>
                    <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                  </div>
                )}
                {search && !loading && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Filters:</span>
                <FilterPill
                  label="Level"
                  value={LEVEL_LABELS[levelFilter]}
                  active={levelFilter !== 'all'}
                  options={[
                    { value: 'all', label: 'All Levels' },
                    { value: 'HS2', label: 'HS2 Only' },
                    { value: 'HS4', label: 'HS4 Only' },
                    { value: 'HS6', label: 'HS6 Only' }
                  ]}
                  onSelect={value => setLevelFilter(value as LevelFilter)}
                />
                <FilterPill
                  label="Status"
                  value={STATUS_LABELS[statusFilter]}
                  active={statusFilter !== 'all'}
                  options={[
                    { value: 'active', label: 'Active' },
                    { value: 'expired', label: 'Expired' },
                    { value: 'all', label: 'All Status' }
                  ]}
                  onSelect={value => setStatusFilter(value as StatusFilter)}
                />
              </div>
            </div>

            {/* Recent searches */}
            {recents.length > 0 && !search && (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Recent
                </div>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {recents.map(item => (
                    <button
                      key={item.code}
                      onClick={() => {
                        setSearch(item.code);
                        setDebouncedSearch(item.code);
                      }}
                      className="group px-3 py-1.5 bg-white hover:bg-blue-50 border border-slate-200 hover:border-blue-300 rounded-lg text-xs text-slate-700 hover:text-blue-700 whitespace-nowrap transition-all duration-200 flex items-center gap-2 shadow-sm"
                    >
                      <span className="font-mono font-semibold">{item.code}</span>
                      <span className="text-slate-400 group-hover:text-blue-400">·</span>
                      <span className="max-w-[200px] truncate">{item.description || '—'}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Results count */}
            <div className="mt-3 flex items-center justify-between text-xs text-slate-600">
              <div className="flex items-center gap-2">
                {!loading && items.length > 0 && (
                  <span className="px-2.5 py-1 bg-blue-50 text-blue-700 font-semibold rounded-full border border-blue-200">
                    {items.length} {items.length === 1 ? 'result' : 'results'}
                  </span>
                )}
                {nextCursor && (
                  <span className="text-slate-500">· More available</span>
                )}
              </div>
              <div className="text-slate-500">
                Use <kbd className="px-1.5 py-0.5 bg-white border border-slate-300 rounded text-[10px] font-mono">⌘/Ctrl + S</kbd> to focus search
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-6 py-6 flex-1 w-full">
        <div className="flex gap-6">
          <section className="flex-1">
            {/* Table Header */}
            <div className="grid grid-cols-[110px_80px_2fr_2fr_100px_140px] gap-4 px-6 py-3.5 border border-slate-200 bg-slate-50 text-xs font-bold text-slate-700 uppercase tracking-wider sticky top-0 z-20 rounded-t-xl border-b-0">
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
                </svg>
                Code
              </span>
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
                Level
              </span>
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                </svg>
                English Description
              </span>
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                </svg>
                Indonesian Description
              </span>
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                Parent
              </span>
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Status
              </span>
            </div>

            {/* Table Body */}
            <div className="bg-white border border-slate-200 border-t-0 rounded-b-xl shadow-sm divide-y divide-slate-100">
              {items.length === 0 && !loading ? (
                <div className="flex items-center justify-center p-12">
                  <div className="text-center max-w-md">
                    <div className="mx-auto w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                      <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                    </div>
                    <h3 className="text-lg font-semibold text-slate-900 mb-2">No HS codes found</h3>
                    <p className="text-sm text-slate-600">
                      {debouncedSearch
                        ? `No matches for "${debouncedSearch}". Try a code prefix like 9405 or different keywords.`
                        : 'Start by searching for a code (e.g., 940500) or description (e.g., "LED module").'}
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {items.map((row, idx) => {
                    const isSelected = selectedIndex === idx;
                    const rowClasses = cx(
                      'relative grid grid-cols-[110px_80px_2fr_2fr_100px_140px] gap-4 px-6 py-4 text-sm items-center transition-all duration-150 cursor-pointer',
                      isSelected
                        ? 'bg-blue-50/80 ring-2 ring-inset ring-blue-300'
                        : 'bg-white hover:bg-slate-50/80'
                    );

                    return (
                      <div
                        key={row.id}
                        role="row"
                        className={rowClasses}
                        onClick={() => {
                          setSelectedIndex(idx);
                          openDrawer(row);
                        }}
                      >
                        <div className="font-mono text-sm font-semibold text-slate-900" role="gridcell">
                          {highlightMatch(row.code, isDigits(debouncedSearch) ? debouncedSearch : '')}
                        </div>
                        <div role="gridcell">
                          <span className={cx('inline-flex items-center px-2.5 py-1 text-xs font-bold rounded-lg border', getLevelColor(row.level))}>
                            {row.level}
                          </span>
                        </div>
                        <div className="text-sm text-slate-700 line-clamp-2" role="gridcell" title={row.descriptionEn}>
                          {highlightMatch(row.descriptionEn, debouncedSearch && !isDigits(debouncedSearch) ? debouncedSearch : '')}
                        </div>
                        <div className="text-sm text-slate-700 line-clamp-2" role="gridcell" title={row.descriptionId}>
                          {highlightMatch(row.descriptionId, debouncedSearch && !isDigits(debouncedSearch) ? debouncedSearch : '')}
                        </div>
                        <div className="text-xs font-mono text-slate-600" role="gridcell">
                          {row.parentCode ? (
                            <span className="px-2 py-1 bg-slate-100 rounded-md border border-slate-200">
                              {row.parentCode}
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </div>
                        <div className="flex flex-col gap-2" role="gridcell">
                          {buildStatusBadge(row.status)}
                          {(row.validFrom || row.validTo) && (
                            <span className="text-[10px] text-slate-500 font-medium">
                              {formatDate(row.validFrom)} – {formatDate(row.validTo)}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* Intersection observer target */}
                  {nextCursor && (
                    <div ref={tableEndRef} className="h-20 flex items-center justify-center">
                      {loadingMore && (
                        <div className="flex items-center gap-2 text-sm text-slate-600">
                          <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Loading more...
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </section>

          {/* Enhanced Drawer */}
          {drawerOpen && (
            <aside className="w-[480px] bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden flex flex-col sticky top-6 h-[calc(100vh-48px)]">
              {/* Drawer Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-slate-50 to-blue-50 flex-shrink-0">
                <div className="flex-1">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Details</p>
                  <h2 className="text-xl font-bold text-slate-900 font-mono">
                    {drawerData?.record.code ?? 'Select a code'}
                  </h2>
                </div>
                <button
                  onClick={() => {
                    setDrawerOpen(false);
                    setDrawerCode(null);
                    setDrawerData(null);
                  }}
                  className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                  aria-label="Close drawer"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Breadcrumbs */}
              <div className="px-6 py-3 border-b border-slate-200 bg-slate-50 flex-shrink-0">
                <div className="flex items-center gap-2 text-xs">
                  <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  {drawerData?.breadcrumbs?.length ? (
                    <div className="flex flex-wrap gap-2">
                      {drawerData.breadcrumbs.map((crumb, idx) => (
                        <div key={crumb.code} className="flex items-center gap-2">
                          <span className="inline-flex items-center gap-2 px-2.5 py-1 bg-white rounded-lg border border-slate-200 shadow-sm">
                            <span className="font-mono font-semibold text-slate-900">{crumb.code}</span>
                            <span className="text-slate-400">·</span>
                            <span className="text-slate-600 text-[11px] max-w-[150px] truncate">{crumb.descriptionEn}</span>
                          </span>
                          {idx < drawerData.breadcrumbs.length - 1 && (
                            <svg className="w-3 h-3 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-slate-500 italic">No parent chain</span>
                  )}
                </div>
              </div>

              {/* Drawer Content */}
              <div className="flex-1 overflow-y-auto px-6 py-6">
                {drawerLoading && (
                  <div className="flex items-center justify-center py-12">
                    <div className="text-center">
                      <svg className="animate-spin w-8 h-8 text-blue-600 mx-auto mb-3" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      <p className="text-sm text-slate-600 font-medium">Loading details...</p>
                    </div>
                  </div>
                )}
                {drawerError && (
                  <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                    <div className="flex items-start gap-3">
                      <svg className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                      </svg>
                      <div>
                        <p className="text-sm font-semibold text-red-900 mb-1">Error loading details</p>
                        <p className="text-sm text-red-700">{drawerError}</p>
                      </div>
                    </div>
                  </div>
                )}
                {drawerData && !drawerLoading && !drawerError && (
                  <DrawerForm
                    data={drawerData}
                    saving={drawerSaving}
                    showExplain={showExplain}
                    onToggleExplain={() => setShowExplain(prev => !prev)}
                    onSave={saveDrawerChanges}
                    onViewHistory={() => showToast('History feature coming soon', 'info')}
                  />
                )}
              </div>
            </aside>
          )}
        </div>
      </main>

      {/* Modern Toast Notifications */}
      {toastQueue.length > 0 && (
        <div className="fixed bottom-6 right-6 space-y-3 z-50">
          {toastQueue.map(toast => (
            <div
              key={toast.id}
              className={cx(
                'flex items-center gap-3 px-5 py-4 rounded-xl shadow-2xl text-sm font-medium text-white min-w-[320px] max-w-md',
                toast.tone === 'success' && 'bg-gradient-to-r from-emerald-500 to-emerald-600',
                toast.tone === 'error' && 'bg-gradient-to-r from-red-500 to-red-600',
                toast.tone === 'info' && 'bg-gradient-to-r from-blue-500 to-blue-600'
              )}
            >
              {toast.tone === 'success' && (
                <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
              )}
              {toast.tone === 'error' && (
                <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
              )}
              {toast.tone === 'info' && (
                <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                </svg>
              )}
              <span className="flex-1">{toast.message}</span>
              <button
                onClick={() => dismissToast(toast.id)}
                className="p-1 hover:bg-white/20 rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {createModalOpen && (
        <CreateHsCodeModal
          jurisdiction={jurisdiction}
          versionYear={versionYear}
          onClose={() => setCreateModalOpen(false)}
          onCreated={(newRow) => {
            setItems(prev => [newRow, ...prev]);
            setSelectedIndex(0);
            addRecent({ code: newRow.code, description: newRow.descriptionEn, updatedAt: newRow.updatedAt });
            showToast('HS code created successfully', 'success');
          }}
          onParentCreated={() => showToast('Parent code created successfully', 'success')}
        />
      )}

      {showImportModal && (
        <ImportModal onClose={() => setShowImportModal(false)} />
      )}
    </div>
  );
}

function isDigits(input: string) {
  return /^[0-9]+$/.test(input.trim());
}

interface FilterPillProps {
  label: string;
  value: string;
  active?: boolean;
  options: Array<{ value: string; label: string }>;
  onSelect: (value: string) => void;
}

function FilterPill({ label, value, active, options, onSelect }: FilterPillProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(prev => !prev)}
        className={cx(
          'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200 border',
          active
            ? 'bg-blue-100 text-blue-700 border-blue-300 shadow-sm'
            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
        )}
      >
        <span className="text-[10px] uppercase tracking-wider opacity-75">{label}</span>
        <span>{value}</span>
        <svg className={cx('w-4 h-4 transition-transform duration-200', open && 'rotate-180')} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-2 w-48 bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden">
            {options.map(option => (
              <button
                key={option.value}
                onClick={() => {
                  onSelect(option.value);
                  setOpen(false);
                }}
                className={cx(
                  'w-full text-left px-4 py-3 text-sm font-medium transition-colors',
                  value === option.label
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-slate-700 hover:bg-slate-50'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface DrawerFormProps {
  data: HsCodeDetailResponse;
  saving: boolean;
  showExplain: boolean;
  onToggleExplain: () => void;
  onSave: (changes: Partial<HsCodeRow>) => Promise<void>;
  onViewHistory: () => void;
}

function DrawerForm({ data, saving, showExplain, onToggleExplain, onSave, onViewHistory }: DrawerFormProps) {
  const [en, setEn] = useState(data.record.descriptionEn);
  const [id, setId] = useState(data.record.descriptionId);
  const [validFrom, setValidFrom] = useState(data.record.validFrom ? data.record.validFrom.substring(0, 10) : '');
  const [validTo, setValidTo] = useState(data.record.validTo ? data.record.validTo.substring(0, 10) : '');
  const [notes, setNotes] = useState(data.record.notes ?? '');

  useEffect(() => {
    setEn(data.record.descriptionEn);
    setId(data.record.descriptionId);
    setValidFrom(data.record.validFrom ? data.record.validFrom.substring(0, 10) : '');
    setValidTo(data.record.validTo ? data.record.validTo.substring(0, 10) : '');
    setNotes(data.record.notes ?? '');
  }, [data]);

  return (
    <form
      className="space-y-5"
      onSubmit={async event => {
        event.preventDefault();
        await onSave({
          descriptionEn: en,
          descriptionId: id,
          validFrom: validFrom ? new Date(validFrom).toISOString() : null,
          validTo: validTo ? new Date(validTo).toISOString() : null,
          notes
        });
      }}
    >
      {/* Metadata Grid */}
      <div className="grid grid-cols-2 gap-4">
        <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Code</p>
          <p className="text-base font-mono font-bold text-slate-900">{data.record.code}</p>
        </div>
        <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Level</p>
          <span className={cx('inline-flex items-center px-2.5 py-1 text-xs font-bold rounded-lg border', getLevelColor(data.record.level))}>
            {data.record.level}
          </span>
        </div>
      </div>

      {data.record.parentCode && (
        <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Parent Code</p>
          <p className="text-sm font-mono font-semibold text-slate-900">{data.record.parentCode}</p>
        </div>
      )}

      {/* Descriptions */}
      <div>
        <label className="block text-sm font-bold text-slate-700 mb-2 flex items-center gap-2">
          <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
          </svg>
          English Description
        </label>
        <textarea
          value={en}
          onChange={event => setEn(event.target.value)}
          rows={3}
          className="w-full border-2 border-slate-200 focus:border-blue-500 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 transition-colors"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-bold text-slate-700 mb-2 flex items-center gap-2">
          <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
          </svg>
          Indonesian Description
        </label>
        <textarea
          value={id}
          onChange={event => setId(event.target.value)}
          rows={3}
          className="w-full border-2 border-slate-200 focus:border-blue-500 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 transition-colors"
          required
        />
      </div>

      {/* Validity Dates */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-bold text-slate-700 mb-2">Valid From</label>
          <input
            type="date"
            value={validFrom}
            onChange={event => setValidFrom(event.target.value)}
            className="w-full border-2 border-slate-200 focus:border-blue-500 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 transition-colors"
          />
        </div>
        <div>
          <label className="block text-sm font-bold text-slate-700 mb-2">Valid To</label>
          <input
            type="date"
            value={validTo}
            onChange={event => setValidTo(event.target.value)}
            className="w-full border-2 border-slate-200 focus:border-blue-500 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 transition-colors"
          />
        </div>
      </div>

      {/* Notes */}
      <div>
        <label className="block text-sm font-bold text-slate-700 mb-2">
          Notes <span className="text-slate-400 font-normal">(optional)</span>
        </label>
        <textarea
          value={notes}
          onChange={event => setNotes(event.target.value)}
          rows={3}
          placeholder="Add any additional notes or comments..."
          className="w-full border-2 border-slate-200 focus:border-blue-500 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 transition-colors placeholder:text-slate-400"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
        <button
          type="submit"
          className="flex-1 px-5 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-lg disabled:bg-blue-300 disabled:cursor-not-allowed transition-all duration-200 shadow-sm hover:shadow-md"
          disabled={saving}
        >
          {saving ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Saving...
            </span>
          ) : (
            <span className="flex items-center justify-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Save Changes
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={onViewHistory}
          className="px-4 py-3 text-sm font-semibold text-slate-700 border-2 border-slate-300 hover:bg-slate-50 rounded-lg transition-colors"
        >
          History
        </button>
        <button
          type="button"
          onClick={onToggleExplain}
          className="px-4 py-3 text-sm font-semibold text-blue-600 border-2 border-blue-200 hover:bg-blue-50 rounded-lg transition-colors"
        >
          {showExplain ? 'Hide' : 'Explain'}
        </button>
      </div>

      {showExplain && (
        <div className="border-2 border-blue-200 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <p className="font-bold text-blue-900 text-sm mb-1">AI-Powered Explanation</p>
              <p className="text-sm text-blue-800 leading-relaxed">
                This feature will provide a plain-language summary of the HS code classification and usage.
                Always review AI suggestions before applying them to your data.
              </p>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}

// Modal components remain the same as before, keeping them from the previous version
interface CreateModalProps {
  jurisdiction: string;
  versionYear: number;
  onClose: () => void;
  onCreated: (row: HsCodeRow) => void;
  onParentCreated: () => void;
}

type CreationStep = 'code' | 'details';

function CreateHsCodeModal({ jurisdiction, versionYear, onClose, onCreated, onParentCreated }: CreateModalProps) {
  const [step, setStep] = useState<CreationStep>('code');
  const [code, setCode] = useState('');
  const [level, setLevel] = useState<HsLevel | null>(null);
  const [parentCode, setParentCode] = useState<string | null>(null);
  const [descriptionEn, setDescriptionEn] = useState('');
  const [descriptionId, setDescriptionId] = useState('');
  const [notes, setNotes] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checkingParent, setCheckingParent] = useState(false);
  const [parentMissing, setParentMissing] = useState(false);
  const [creatingParent, setCreatingParent] = useState(false);
  const [parentEn, setParentEn] = useState('');
  const [parentId, setParentId] = useState('');
  const [saving, setSaving] = useState(false);
  const [parentSaving, setParentSaving] = useState(false);

  useEffect(() => {
    const normalized = code.replace(/\s+/g, '');
    if (/^[0-9]{2}$/.test(normalized)) {
      setLevel('HS2');
      setParentCode(null);
    } else if (/^[0-9]{4}$/.test(normalized)) {
      setLevel('HS4');
      setParentCode(normalized.slice(0, 2));
    } else if (/^[0-9]{6}$/.test(normalized)) {
      setLevel('HS6');
      setParentCode(normalized.slice(0, 4));
    } else {
      setLevel(null);
      setParentCode(null);
    }
  }, [code]);

  async function handleContinue() {
    setError(null);
    const normalized = code.replace(/\s+/g, '');
    if (!/^[0-9]{2}([0-9]{2}){0,2}$/.test(normalized)) {
      setError('Code must be 2, 4, or 6 digits.');
      return;
    }
    if (normalized.length === 4 || normalized.length === 6) {
      if (!parentCode) {
        setError('Parent must exist for HS4/HS6.');
        return;
      }
      setCheckingParent(true);
      try {
        const response = await fetch(`/api/hs-codes/${parentCode}?jurisdiction=${jurisdiction}&versionYear=${versionYear}`);
        if (!response.ok) {
          setParentMissing(true);
          setCreatingParent(false);
          setParentEn(`HS${parentCode.length}: ${parentCode}`);
          setParentId(`HS${parentCode.length}: ${parentCode}`);
          return;
        }
        setParentMissing(false);
        setStep('details');
      } finally {
        setCheckingParent(false);
      }
    } else {
      setParentMissing(false);
      setStep('details');
    }
  }

  async function handleCreateParent() {
    if (!parentCode) return;
    setCreatingParent(true);
    setError(null);
    try {
      setParentSaving(true);
      const response = await fetch('/api/hs-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: parentCode,
          jurisdiction,
          versionYear,
          descriptionEn: parentEn,
          descriptionId: parentId
        })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || 'Failed to create parent');
      }

      onParentCreated();
      setParentMissing(false);
      setCreatingParent(false);
      setStep('details');
    } catch (error: any) {
      console.error(error);
      setError(error.message || 'Failed to create parent');
    }
    finally {
      setParentSaving(false);
    }
  }

  async function handleSubmit() {
    setError(null);
    if (!descriptionEn.trim() || !descriptionId.trim()) {
      setError('Descriptions cannot be empty.');
      return;
    }
    if (validFrom && validTo && new Date(validFrom) > new Date(validTo)) {
      setError('Valid to must be after valid from.');
      return;
    }

    setSaving(true);
    try {
      const response = await fetch('/api/hs-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          jurisdiction,
          versionYear,
          parentCode,
          descriptionEn,
          descriptionId,
          notes,
          validFrom: validFrom || null,
          validTo: validTo || null
        })
      });

      if (response.status === 409) {
        const payload = await response.json();
        setError(payload?.error?.message || 'That code already exists. Opening it for you…');
        return;
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || 'Failed to create HS code');
      }

      const created = await response.json();
      onCreated(created);
      onClose();
    } catch (error: any) {
      console.error(error);
      setError(error.message || 'Failed to create HS code');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-slate-50 to-blue-50 sticky top-0 z-10">
          <h2 className="text-xl font-bold text-slate-900">Add New HS Code</h2>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5 space-y-5">
          <div className="flex items-center gap-3">
            <div className={cx(
              'flex items-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm',
              step === 'code' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'
            )}>
              <span className={cx(
                'flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold',
                step === 'code' ? 'bg-blue-600 text-white' : 'bg-slate-300 text-slate-600'
              )}>1</span>
              Enter Code
            </div>
            <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <div className={cx(
              'flex items-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm',
              step === 'details' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'
            )}>
              <span className={cx(
                'flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold',
                step === 'details' ? 'bg-blue-600 text-white' : 'bg-slate-300 text-slate-600'
              )}>2</span>
              Add Details
            </div>
          </div>

          {step === 'code' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">HS Code</label>
                <input
                  value={code}
                  onChange={event => setCode(event.target.value)}
                  placeholder="Enter 2, 4, or 6 digits (e.g., 94, 9405, 940500)"
                  className="w-full border-2 border-slate-200 focus:border-blue-500 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 font-mono"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Level</p>
                  <p className="text-base font-semibold text-slate-900">{level ?? '—'}</p>
                </div>
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Parent Code</p>
                  <p className="text-base font-mono font-semibold text-slate-900">{parentCode ?? '—'}</p>
                </div>
              </div>
              {error && (
                <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
                  <svg className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                  </svg>
                  <p className="text-sm font-medium text-red-900">{error}</p>
                </div>
              )}
              {parentMissing && parentCode && !creatingParent && (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                  <div className="flex items-start gap-3 mb-3">
                    <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                    <div>
                      <p className="text-sm font-semibold text-amber-900 mb-1">Parent code not found</p>
                      <p className="text-sm text-amber-800">The parent code <strong>{parentCode}</strong> doesn't exist yet. Create it first?</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setCreatingParent(true)}
                      className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg transition-colors"
                    >
                      Create Parent Code
                    </button>
                    <button
                      onClick={() => setParentMissing(false)}
                      className="px-4 py-2 text-sm font-semibold text-amber-700 hover:bg-amber-100 rounded-lg transition-colors"
                    >
                      Skip for Now
                    </button>
                  </div>
                </div>
              )}
              {creatingParent && parentCode && (
                <div className="border-2 border-amber-200 rounded-xl p-5 bg-amber-50/50 space-y-4">
                  <p className="text-sm font-bold text-amber-900">Create parent code: {parentCode}</p>
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-2">English Description</label>
                    <textarea
                      value={parentEn}
                      onChange={event => setParentEn(event.target.value)}
                      rows={2}
                      className="w-full border-2 border-slate-200 focus:border-amber-500 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-amber-200"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-2">Indonesian Description</label>
                    <textarea
                      value={parentId}
                      onChange={event => setParentId(event.target.value)}
                      rows={2}
                      className="w-full border-2 border-slate-200 focus:border-amber-500 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-amber-200"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleCreateParent}
                      className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg disabled:bg-amber-300 disabled:cursor-not-allowed transition-colors"
                      type="button"
                      disabled={parentSaving}
                    >
                      {parentSaving ? 'Saving...' : 'Save Parent Code'}
                    </button>
                    <button
                      onClick={() => setCreatingParent(false)}
                      className="px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              <div className="flex justify-end pt-2">
                <button
                  onClick={handleContinue}
                  className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-lg disabled:bg-blue-300 disabled:cursor-not-allowed transition-all duration-200 shadow-sm hover:shadow-md"
                  disabled={checkingParent}
                >
                  {checkingParent ? 'Checking parent...' : 'Continue'}
                </button>
              </div>
            </div>
          )}

          {step === 'details' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Code</p>
                  <p className="text-base font-mono font-bold text-slate-900">{code}</p>
                </div>
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Level</p>
                  <span className={cx('inline-flex items-center px-2.5 py-1 text-xs font-bold rounded-lg border', level ? getLevelColor(level) : '')}>
                    {level ?? '—'}
                  </span>
                </div>
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">English Description</label>
                <textarea
                  value={descriptionEn}
                  onChange={event => setDescriptionEn(event.target.value)}
                  rows={3}
                  placeholder="Enter the English description..."
                  className="w-full border-2 border-slate-200 focus:border-blue-500 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">Indonesian Description</label>
                <textarea
                  value={descriptionId}
                  onChange={event => setDescriptionId(event.target.value)}
                  rows={3}
                  placeholder="Enter the Indonesian description..."
                  className="w-full border-2 border-slate-200 focus:border-blue-500 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-2">Valid From</label>
                  <input
                    type="date"
                    value={validFrom}
                    onChange={event => setValidFrom(event.target.value)}
                    className="w-full border-2 border-slate-200 focus:border-blue-500 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-2">Valid To</label>
                  <input
                    type="date"
                    value={validTo}
                    onChange={event => setValidTo(event.target.value)}
                    className="w-full border-2 border-slate-200 focus:border-blue-500 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">
                  Notes <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <textarea
                  value={notes}
                  onChange={event => setNotes(event.target.value)}
                  rows={2}
                  placeholder="Add any additional notes or comments..."
                  className="w-full border-2 border-slate-200 focus:border-blue-500 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 placeholder:text-slate-400"
                />
              </div>
              {error && (
                <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
                  <svg className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                  </svg>
                  <p className="text-sm font-medium text-red-900">{error}</p>
                </div>
              )}
              <div className="flex justify-between pt-2">
                <button
                  onClick={() => setStep('code')}
                  className="px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                  type="button"
                >
                  ← Back
                </button>
                <button
                  onClick={handleSubmit}
                  className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-lg disabled:bg-blue-300 disabled:cursor-not-allowed transition-all duration-200 shadow-sm hover:shadow-md"
                  type="button"
                  disabled={saving}
                >
                  {saving ? 'Creating...' : 'Create HS Code'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ImportModalProps {
  onClose: () => void;
}

function ImportModal({ onClose }: ImportModalProps) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-slate-50 to-blue-50">
          <h2 className="text-xl font-bold text-slate-900">Import HS Codes</h2>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl flex items-start gap-3">
            <svg className="w-6 h-6 text-blue-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm font-semibold text-blue-900 mb-1">CSV Import Coming Soon</p>
              <p className="text-sm text-blue-800 leading-relaxed">
                Prepare a CSV file with columns: <strong>code</strong>, <strong>level</strong>, <strong>description_en</strong>,
                <strong> description_id</strong>, <strong>parent_code</strong>, <strong>valid_from</strong>, <strong>valid_to</strong>.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-full px-5 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-lg transition-all duration-200 shadow-sm hover:shadow-md"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
