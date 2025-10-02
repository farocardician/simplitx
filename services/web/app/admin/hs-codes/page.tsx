'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { UIEvent } from 'react';
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
const ROW_HEIGHT = 72;
const OVERSCAN = 6;

const LEVEL_LABELS: Record<LevelFilter, string> = {
  all: 'All levels',
  HS2: 'HS2',
  HS4: 'HS4',
  HS6: 'HS6'
};

const STATUS_LABELS: Record<StatusFilter, string> = {
  active: 'Active',
  expired: 'Expired',
  all: 'All'
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
  return date.toISOString().split('T')[0];
}

function highlightMatch(text: string, term: string) {
  if (!term) return text;
  const lower = term.toLowerCase();
  const index = text.toLowerCase().indexOf(lower);
  if (index === -1) return text;
  return (
    <span>
      {text.slice(0, index)}
      <mark className="bg-yellow-200 px-0.5 rounded-sm">{text.slice(index, index + term.length)}</mark>
      {text.slice(index + term.length)}
    </span>
  );
}

function buildStatusPill(status: HsStatus) {
  if (status === 'active') {
    return <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded-full">Active</span>;
  }
  return <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 rounded-full">Expired</span>;
}

export default function HsCodeManagerPage() {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);

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
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState<{ en: string; id: string } | null>(null);
  const [savingRowId, setSavingRowId] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
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
  const [viewportHeight, setViewportHeight] = useState(600);
  const [scrollTop, setScrollTop] = useState(0);
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

  // Resize observer for virtualized list
  useEffect(() => {
    const element = tableContainerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.contentRect) {
          setViewportHeight(entry.contentRect.height);
        }
      }
    });
    observer.observe(element);
    setViewportHeight(element.getBoundingClientRect().height || 600);
    return () => observer.disconnect();
  }, [tableContainerRef]);

  // Fetch data when dependencies change
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setInlineError(null);
      try {
        const params = new URLSearchParams({
          jurisdiction,
          versionYear: String(versionYear),
          level: levelFilter,
          status: statusFilter,
          limit: '120'
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

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.target as HTMLElement)?.tagName === 'INPUT' || (event.target as HTMLElement)?.tagName === 'TEXTAREA') {
        if (event.key === 'Escape' && editingRowId) {
          cancelInlineEdit();
        }
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
            ensureRowVisible(next);
            return next;
          });
          break;
        }
        case 'ArrowUp': {
          event.preventDefault();
          setSelectedIndex(prev => {
            const next = prev === null ? 0 : Math.max(0, prev - 1);
            ensureRowVisible(next);
            return next;
          });
          break;
        }
        case 'Enter': {
          event.preventDefault();
          if (selectedIndex !== null) {
            beginInlineEdit(items[selectedIndex]);
          }
          break;
        }
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

      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && editingRowId) {
        event.preventDefault();
        saveInlineEdit();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [items, selectedIndex, editingRowId, editBuffer, drawerOpen]);

  const ensureRowVisible = useCallback(
    (index: number | null) => {
      if (index === null) return;
      const container = tableContainerRef.current;
      if (!container) return;
      const top = index * ROW_HEIGHT;
      const bottom = top + ROW_HEIGHT;
      if (top < container.scrollTop) {
        container.scrollTo({ top });
      } else if (bottom > container.scrollTop + container.clientHeight) {
        container.scrollTo({ top: bottom - container.clientHeight });
      }
    },
    []
  );

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    setScrollTop(target.scrollTop);

    const startIndex = Math.floor(target.scrollTop / ROW_HEIGHT);
    const endIndex = startIndex + Math.ceil(target.clientHeight / ROW_HEIGHT) + OVERSCAN;
    if (endIndex > items.length - 10 && nextCursor && !loading && !loadingMore) {
      loadMore();
    }
  };

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        jurisdiction,
        versionYear: String(versionYear),
        level: levelFilter,
        status: statusFilter,
        limit: '120',
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
    }
  }, [nextCursor, jurisdiction, versionYear, levelFilter, statusFilter, debouncedSearch]);

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    items.length,
    startIndex + Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
  );
  const visibleRows = items.slice(startIndex, endIndex);

  function beginInlineEdit(row: HsCodeRow) {
    setEditingRowId(row.id);
    setEditBuffer({ en: row.descriptionEn, id: row.descriptionId });
    setInlineError(null);
  }

  function cancelInlineEdit() {
    setEditingRowId(null);
    setEditBuffer(null);
    setInlineError(null);
  }

  async function saveInlineEdit() {
    if (!editingRowId || !editBuffer) return;
    if (!editBuffer.en.trim() || !editBuffer.id.trim()) {
      setInlineError('Descriptions cannot be empty.');
      return;
    }

    const row = items.find(item => item.id === editingRowId);
    if (!row) {
      cancelInlineEdit();
      return;
    }

    setSavingRowId(row.id);
    setInlineError(null);

    try {
      const payload = {
        descriptionEn: editBuffer.en.trim(),
        descriptionId: editBuffer.id.trim(),
        updatedAt: row.updatedAt
      };

      const response = await fetch(`/api/hs-codes/${row.code}?jurisdiction=${jurisdiction}&versionYear=${versionYear}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.status === 409) {
        const errorPayload = await response.json();
        setInlineError(errorPayload?.error?.message || 'Updated elsewhere. Review changes?');
        showToast('Updated elsewhere. Review changes?', 'info');
        return;
      }

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null);
        throw new Error(errorPayload?.error?.message || 'Failed to save.');
      }

      const updatedRow = await response.json();
      setItems(prev => prev.map(item => (item.id === row.id ? { ...item, ...updatedRow } : item)));
      setEditingRowId(null);
      setEditBuffer(null);
      addRecent({ code: row.code, description: editBuffer.en.trim(), updatedAt: new Date().toISOString() });
      showToast('Saved.', 'success');
    } catch (error: any) {
      console.error(error);
      setInlineError(error.message || 'Failed to save.');
      showToast(error.message || 'Failed to save.', 'error');
    } finally {
      setSavingRowId(null);
    }
  }

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
      showToast('Saved.', 'success');
    } catch (error: any) {
      console.error(error);
      setDrawerError(error.message || 'Failed to save changes');
      showToast(error.message || 'Failed to save changes', 'error');
    } finally {
      setDrawerSaving(false);
    }
  }

  const selectedRow = selectedIndex !== null ? items[selectedIndex] : null;

  useEffect(() => {
    // Focus search on load
    searchInputRef.current?.focus();
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="border-b bg-white sticky top-0 z-30 shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center gap-4">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">HS Code Manager</h1>
            <p className="text-sm text-gray-500">Find, edit, and create HS2/HS4/HS6 codes without leaving the keyboard.</p>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <select
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={jurisdiction}
              onChange={event => setJurisdiction(event.target.value.toUpperCase())}
            >
              {DEFAULT_JURISDICTIONS.map(code => (
                <option key={code} value={code}>{code}</option>
              ))}
            </select>
            <select
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={versionYear}
              onChange={event => setVersionYear(Number(event.target.value))}
            >
              {DEFAULT_VERSIONS.map(year => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
            <button
              onClick={() => setCreateModalOpen(true)}
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <span>＋</span>
              Add HS Code
            </button>
            <button
              onClick={() => setShowImportModal(true)}
              className="inline-flex items-center gap-2 border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium px-4 py-2 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              Import
            </button>
            <button
              onClick={() => showToast('Help content coming soon.', 'info')}
              className="p-2 text-gray-500 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-400 rounded-full"
              aria-label="Help"
            >
              ?
            </button>
          </div>
        </div>
        <div className="border-t bg-white">
          <div className="max-w-7xl mx-auto px-6 py-3 flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <input
                  ref={searchInputRef}
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder="Search by code or description (e.g., 940500 or ‘led module’)"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  aria-label="Search HS codes"
                />
                {(loading || loadingMore) && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 animate-spin" aria-hidden>⟳</div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <FilterPill
                  label="Level"
                  value={LEVEL_LABELS[levelFilter]}
                  options={[{ value: 'all', label: 'All levels' }, { value: 'HS2', label: 'HS2' }, { value: 'HS4', label: 'HS4' }, { value: 'HS6', label: 'HS6' }]}
                  onSelect={value => setLevelFilter(value as LevelFilter)}
                />
                <FilterPill
                  label="Status"
                  value={STATUS_LABELS[statusFilter]}
                  options={[{ value: 'active', label: 'Active' }, { value: 'expired', label: 'Expired' }, { value: 'all', label: 'All' }]}
                  onSelect={value => setStatusFilter(value as StatusFilter)}
                />
              </div>
            </div>
            {recents.length > 0 && (
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span className="uppercase tracking-wide font-semibold text-gray-600">Recents</span>
                <div className="flex gap-2 overflow-x-auto">
                  {recents.map(item => (
                    <button
                      key={item.code}
                      onClick={() => {
                        setSearch(item.code);
                        setDebouncedSearch(item.code);
                      }}
                      className="px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded-md text-gray-700 whitespace-nowrap"
                    >
                      {item.code} · {item.description || '—'}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-4 flex-1 w-full flex gap-4">
        <section className="flex-1 flex flex-col bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
          <div className="grid grid-cols-[120px_80px_1fr_1fr_100px_140px] gap-3 px-4 py-2 border-b bg-gray-50 text-xs font-semibold text-gray-600 sticky top-0 z-10">
            <span>Code</span>
            <span>Level</span>
            <span>English description</span>
            <span>Indonesian description</span>
            <span>Parent</span>
            <span>Validity</span>
          </div>

          <div
            ref={tableContainerRef}
            className="flex-1 overflow-auto focus:outline-none"
            onScroll={handleScroll}
            role="grid"
            aria-rowcount={items.length}
          >
            {items.length === 0 && !loading ? (
              <div className="flex h-full items-center justify-center text-gray-500 text-sm">
                {debouncedSearch ? 'No matches. Try a code prefix like 9405 or different keywords.' : 'Type a code (940500) or a phrase (‘led module’).'}
              </div>
            ) : (
              <div style={{ height: items.length * ROW_HEIGHT }} className="relative">
                <div
                  className="absolute inset-x-0"
                  style={{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }}
                >
                  {visibleRows.map((row, idx) => {
                    const rowIndex = startIndex + idx;
                    const isSelected = selectedIndex === rowIndex;
                    const isEditing = editingRowId === row.id;
                    const rowClasses = cx(
                      'relative grid grid-cols-[120px_80px_1fr_1fr_100px_140px] gap-3 px-4 py-3 text-sm border-b border-gray-100 items-center transition-colors',
                      isSelected ? 'bg-blue-50/60 ring-1 ring-blue-200' : 'bg-white hover:bg-gray-50'
                    );

                    return (
                      <div
                        key={row.id}
                        role="row"
                        data-id={row.id}
                        tabIndex={0}
                        className={rowClasses}
                        onClick={() => setSelectedIndex(rowIndex)}
                        onDoubleClick={() => beginInlineEdit(row)}
                      >
                        <div className="font-mono text-xs text-gray-900" role="gridcell">
                          {highlightMatch(row.code, isDigits(debouncedSearch) ? debouncedSearch : '')}
                        </div>
                        <div className="text-xs text-gray-600" role="gridcell">{row.level}</div>
                        <div className="text-sm text-gray-900" role="gridcell">
                          {isEditing ? (
                            <textarea
                              className="w-full resize-none border border-blue-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                              rows={2}
                              value={editBuffer?.en ?? ''}
                              onChange={event => setEditBuffer(prev => prev ? { ...prev, en: event.target.value } : { en: event.target.value, id: row.descriptionId })}
                            />
                          ) : (
                            highlightMatch(row.descriptionEn, debouncedSearch && !isDigits(debouncedSearch) ? debouncedSearch : '')
                          )}
                        </div>
                        <div className="text-sm text-gray-900" role="gridcell">
                          {isEditing ? (
                            <textarea
                              className="w-full resize-none border border-blue-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                              rows={2}
                              value={editBuffer?.id ?? ''}
                              onChange={event => setEditBuffer(prev => prev ? { ...prev, id: event.target.value } : { id: event.target.value, en: row.descriptionEn })}
                            />
                          ) : (
                            highlightMatch(row.descriptionId, debouncedSearch && !isDigits(debouncedSearch) ? debouncedSearch : '')
                          )}
                        </div>
                        <div className="text-xs text-gray-600" role="gridcell">{row.parentCode ?? '—'}</div>
                        <div className="flex flex-col gap-1 text-xs text-gray-500" role="gridcell">
                          <span>{formatDate(row.validFrom)} – {formatDate(row.validTo)}</span>
                          <span>{buildStatusPill(row.status)}</span>
                        </div>
                        {isSelected && !isEditing && (
                          <div className="absolute right-4 flex items-center gap-3 text-xs text-blue-600">
                            <button onClick={() => beginInlineEdit(row)} className="underline decoration-dotted">Enter to edit</button>
                            <button onClick={() => openDrawer(row)} className="underline decoration-dotted">→ Details</button>
                          </div>
                        )}
                        {isEditing && (
                          <div className="col-span-6 flex items-center justify-between text-xs text-gray-600 mt-2">
                            <div className="flex items-center gap-3 text-xs text-blue-600">
                              <span>Ctrl/Cmd + Enter to save</span>
                              <span>Esc to cancel</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {inlineError && <span className="text-red-600">{inlineError}</span>}
                              <button
                                onClick={saveInlineEdit}
                                className="px-3 py-1 bg-blue-600 text-white rounded-md disabled:bg-blue-200"
                                disabled={savingRowId === row.id}
                              >
                                {savingRowId === row.id ? 'Saving…' : 'Save'}
                              </button>
                              <button onClick={cancelInlineEdit} className="px-3 py-1 border border-gray-300 rounded-md">Cancel</button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </section>

        <aside className={cx(
          'relative w-96 transition-transform duration-200',
          drawerOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'
        )}>
          <div className="absolute inset-y-0 right-0 w-96 bg-white border border-gray-200 rounded-lg shadow-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <div>
                <p className="text-xs font-medium text-gray-500">Breadcrumb</p>
                <h2 className="text-base font-semibold text-gray-900">
                  {drawerData?.record.code ?? 'Select a code'}
                </h2>
              </div>
              <button
                onClick={() => {
                  setDrawerOpen(false);
                  setDrawerCode(null);
                  setDrawerData(null);
                }}
                className="text-gray-400 hover:text-gray-600"
                aria-label="Close drawer"
              >
                ✕
              </button>
            </div>
            <div className="px-4 py-3 border-b text-xs text-gray-600 flex flex-wrap gap-1">
              {drawerData?.breadcrumbs?.length ? (
                drawerData.breadcrumbs.map(crumb => (
                  <span key={crumb.code} className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 rounded-full">
                    <span className="font-mono">{crumb.code}</span>
                    <span>{crumb.descriptionEn}</span>
                  </span>
                ))
              ) : (
                <span>No parent chain</span>
              )}
            </div>
            <div className="px-4 py-4 space-y-4 overflow-y-auto h-[calc(100%-160px)]">
              {drawerLoading && <div className="text-sm text-gray-500">Loading…</div>}
              {drawerError && <div className="text-sm text-red-600">{drawerError}</div>}
              {drawerData && !drawerLoading && !drawerError && (
                <DrawerForm
                  data={drawerData}
                  saving={drawerSaving}
                  showExplain={showExplain}
                  onToggleExplain={() => setShowExplain(prev => !prev)}
                  onSave={saveDrawerChanges}
                  onViewHistory={() => showToast('History not yet available.', 'info')}
                />
              )}
            </div>
          </div>
        </aside>
      </main>

      {toastQueue.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 space-y-2 z-50">
          {toastQueue.map(toast => (
            <div
              key={toast.id}
              className={cx(
                'px-4 py-2 rounded-md shadow-lg text-sm text-white flex items-center gap-3',
                toast.tone === 'success' && 'bg-green-600',
                toast.tone === 'error' && 'bg-red-600',
                toast.tone === 'info' && 'bg-blue-600'
              )}
            >
              <span>{toast.message}</span>
              <button onClick={() => dismissToast(toast.id)} className="text-white/80 hover:text-white">Dismiss</button>
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
            ensureRowVisible(0);
            showToast('Saved.', 'success');
          }}
          onParentCreated={() => showToast('Parent saved.', 'success')}
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
  options: Array<{ value: string; label: string }>;
  onSelect: (value: string) => void;
}

function FilterPill({ label, value, options, onSelect }: FilterPillProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(prev => !prev)}
        className="inline-flex items-center gap-2 px-3 py-1.5 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50"
      >
        <span className="text-xs uppercase text-gray-500">{label}</span>
        <span>{value}</span>
        <span className="text-gray-400">▾</span>
      </button>
      {open && (
        <div className="absolute z-20 mt-2 w-44 bg-white border border-gray-200 rounded-md shadow-lg">
          {options.map(option => (
            <button
              key={option.value}
              onClick={() => {
                onSelect(option.value);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100"
            >
              {option.label}
            </button>
          ))}
        </div>
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
      className="space-y-3 text-sm"
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
      <div className="grid grid-cols-2 gap-3 text-xs text-gray-500">
        <div>
          <p className="uppercase tracking-wide text-[0.65rem] font-semibold">Code</p>
          <p className="text-gray-900 text-sm font-mono">{data.record.code}</p>
        </div>
        <div>
          <p className="uppercase tracking-wide text-[0.65rem] font-semibold">Level</p>
          <p className="text-gray-900 text-sm">{data.record.level}</p>
        </div>
        <div>
          <p className="uppercase tracking-wide text-[0.65rem] font-semibold">Parent</p>
          <p className="text-gray-900 text-sm">{data.record.parentCode ?? '—'}</p>
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold text-gray-600 mb-1">English description</label>
        <textarea
          value={en}
          onChange={event => setEn(event.target.value)}
          rows={3}
          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
        />
      </div>

      <div>
        <label className="block text-xs font-semibold text-gray-600 mb-1">Indonesian description</label>
        <textarea
          value={id}
          onChange={event => setId(event.target.value)}
          rows={3}
          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Valid from</label>
          <input
            type="date"
            value={validFrom}
            onChange={event => setValidFrom(event.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Valid to</label>
          <input
            type="date"
            value={validTo}
            onChange={event => setValidTo(event.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold text-gray-600 mb-1">Notes</label>
        <textarea
          value={notes}
          onChange={event => setNotes(event.target.value)}
          rows={3}
          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md disabled:bg-blue-300"
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onViewHistory}
          className="px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-md"
        >
          View history
        </button>
        <button
          type="button"
          onClick={onToggleExplain}
          className="px-3 py-2 text-sm text-blue-600 border border-blue-200 rounded-md"
        >
          {showExplain ? 'Hide explanation' : 'Explain code'}
        </button>
      </div>

      {showExplain && (
        <div className="border border-blue-100 bg-blue-50 text-xs text-blue-800 rounded-md px-3 py-2">
          <p className="font-semibold mb-1">AI assist</p>
          <p>This space will offer a plain-language summary. Review suggestions before using.</p>
        </div>
      )}
    </form>
  );
}

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-2xl bg-white rounded-lg shadow-xl">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-base font-semibold text-gray-900">Add HS Code</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className={cx('px-2 py-1 rounded-full', step === 'code' ? 'bg-blue-100 text-blue-700 font-medium' : 'bg-gray-100 text-gray-600')}>1. Code</span>
            <span>→</span>
            <span className={cx('px-2 py-1 rounded-full', step === 'details' ? 'bg-blue-100 text-blue-700 font-medium' : 'bg-gray-100 text-gray-600')}>2. Describe</span>
          </div>

          {step === 'code' && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">HS code</label>
                <input
                  value={code}
                  onChange={event => setCode(event.target.value)}
                  placeholder="Enter 2, 4, or 6 digits"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs text-gray-600">
                <div>
                  <p className="uppercase text-[0.65rem] font-semibold">Level</p>
                  <p className="text-sm text-gray-900">{level ?? '—'}</p>
                </div>
                <div>
                  <p className="uppercase text-[0.65rem] font-semibold">Parent</p>
                  <p className="text-sm text-gray-900">{parentCode ?? '—'}</p>
                </div>
              </div>
              {error && <div className="text-sm text-red-600">{error}</div>}
              {parentMissing && parentCode && !creatingParent && (
                <div className="bg-yellow-50 border border-yellow-200 text-sm text-yellow-800 rounded-md px-3 py-2 space-y-2">
                  <p>{parentCode} is missing. Create the parent now?</p>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setCreatingParent(true)} className="px-3 py-1 bg-yellow-600 text-white rounded-md">Create parent</button>
                    <button onClick={() => setParentMissing(false)} className="text-yellow-700 underline">Skip</button>
                  </div>
                </div>
              )}
              {creatingParent && parentCode && (
                <div className="border border-gray-200 rounded-md p-3 space-y-3">
                  <p className="text-sm font-medium text-gray-800">Create parent {parentCode}</p>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">English description</label>
                    <textarea
                      value={parentEn}
                      onChange={event => setParentEn(event.target.value)}
                      rows={2}
                      className="w-full border border-gray-300 rounded-md px-3 py-2"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">Indonesian description</label>
                    <textarea
                      value={parentId}
                      onChange={event => setParentId(event.target.value)}
                      rows={2}
                      className="w-full border border-gray-300 rounded-md px-3 py-2"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleCreateParent}
                      className="px-3 py-2 bg-blue-600 text-white rounded-md disabled:bg-blue-300"
                      type="button"
                      disabled={parentSaving}
                    >
                      {parentSaving ? 'Saving…' : 'Save parent'}
                    </button>
                    <button onClick={() => setCreatingParent(false)} className="text-sm text-gray-600 underline">Cancel</button>
                  </div>
                </div>
              )}
              <div className="flex justify-end">
                <button
                  onClick={handleContinue}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md disabled:bg-blue-300"
                  disabled={checkingParent}
                >
                  {checkingParent ? 'Checking parent…' : 'Continue'}
                </button>
              </div>
            </div>
          )}

          {step === 'details' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-xs text-gray-600">
                <div>
                  <p className="uppercase text-[0.65rem] font-semibold">Code</p>
                  <p className="text-sm text-gray-900 font-mono">{code}</p>
                </div>
                <div>
                  <p className="uppercase text-[0.65rem] font-semibold">Level</p>
                  <p className="text-sm text-gray-900">{level ?? '—'}</p>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">English description</label>
                <textarea
                  value={descriptionEn}
                  onChange={event => setDescriptionEn(event.target.value)}
                  rows={3}
                  className="w-full border border-gray-300 rounded-md px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Indonesian description</label>
                <textarea
                  value={descriptionId}
                  onChange={event => setDescriptionId(event.target.value)}
                  rows={3}
                  className="w-full border border-gray-300 rounded-md px-3 py-2"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Valid from</label>
                  <input type="date" value={validFrom} onChange={event => setValidFrom(event.target.value)} className="w-full border border-gray-300 rounded-md px-3 py-2" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Valid to</label>
                  <input type="date" value={validTo} onChange={event => setValidTo(event.target.value)} className="w-full border border-gray-300 rounded-md px-3 py-2" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Notes <span className="text-gray-400">(optional)</span></label>
                <textarea value={notes} onChange={event => setNotes(event.target.value)} rows={2} className="w-full border border-gray-300 rounded-md px-3 py-2" />
              </div>
              {error && <div className="text-sm text-red-600">{error}</div>}
              <div className="flex justify-between">
                <button onClick={() => setStep('code')} className="text-sm text-gray-600 underline" type="button">Back</button>
                <button onClick={handleSubmit} className="px-4 py-2 bg-blue-600 text-white rounded-md" type="button" disabled={saving}>
                  {saving ? 'Saving…' : 'Create'}
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
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-base font-semibold text-gray-900">Import HS codes</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
        <div className="px-5 py-4 space-y-3 text-sm text-gray-600">
          <p>CSV import is coming soon. Prepare a file with columns: code, level, description_en, description_id, parent_code, valid_from, valid_to.</p>
          <button onClick={onClose} className="px-4 py-2 bg-blue-600 text-white rounded-md">Got it</button>
        </div>
      </div>
    </div>
  );
}
