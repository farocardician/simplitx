'use client';

import { useState, useEffect, useRef, useMemo, useCallback, type ChangeEvent, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import TransactionCodeDropdown from '@/components/TransactionCodeDropdown';
import { PartyFilters, PartySelectionPayload, PartyRole } from '@/types/party-admin';

interface Party {
  id: string;
  displayName: string;
  partyType: PartyRole;
  tinDisplay: string;
  countryCode: string | null;
  transactionCode: string | null;
  addressFull: string | null;
  email: string | null;
  buyerDocument: string | null;
  buyerDocumentNumber: string | null;
  buyerIdtku: string | null;
  createdAt: string;
  updatedAt: string;
  sellerId: string | null;
  seller?: {
    id: string;
    displayName: string;
    tinDisplay: string;
  } | null;
}

interface TransactionCode {
  code: string;
  name: string;
  description: string;
}

interface SellerOption {
  id: string;
  displayName: string;
  tinDisplay: string;
}

interface ApiTransactionCode {
  code: string;
  name: string;
  description?: string;
}

interface PartyPayloadInput {
  displayName: string;
  tinDisplay: string;
  countryCode: string | null;
  transactionCode: string | null;
  addressFull: string | null;
  email: string | null;
  buyerDocument: string | null;
  buyerDocumentNumber: string | null;
  buyerIdtku: string | null;
  partyType: PartyRole;
  sellerId: string | null;
}

type ApiPartyResponse = Party & {
  seller?: SellerOption | null;
};

interface PaginationInfo {
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
  hasMore: boolean;
}

export default function PartiesManagementPage() {
  const searchParams = useSearchParams();

  // Initialize filters from URL params immediately
  const initialPartyId = searchParams.get('id') || '';
  const initialBuyerSearch = !initialPartyId ? (searchParams.get('buyer') || '') : '';

  const [parties, setParties] = useState<Party[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState(initialBuyerSearch);
  const [debouncedQuery, setDebouncedQuery] = useState(initialBuyerSearch);
  const [partyIdFilter, setPartyIdFilter] = useState<string>(initialPartyId);
  const [countryFilter, setCountryFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<PartyRole | ''>('');
  const [sellerFilter, setSellerFilter] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingCell, setEditingCell] = useState<{ partyId: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [toast, setToast] = useState<{ message: ReactNode; type: 'success' | 'error'; undo?: () => void } | null>(null);
  const [pagination, setPagination] = useState<PaginationInfo>({
    page: 1,
    limit: 50,
    totalCount: 0,
    totalPages: 0,
    hasMore: false
  });
  const [transactionCodes, setTransactionCodes] = useState<TransactionCode[]>([]);
  const [transactionCodesError, setTransactionCodesError] = useState<string | null>(null);
  const [sellers, setSellers] = useState<SellerOption[]>([]);
  const [sellersLoading, setSellersLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [allSelected, setAllSelected] = useState(false);
  const [selectionFiltersSnapshot, setSelectionFiltersSnapshot] = useState<PartyFilters | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentFilters = useMemo<PartyFilters>(() => {
    const filters: PartyFilters = {};
    if (partyIdFilter) {
      filters.partyId = partyIdFilter;
    }
    if (debouncedQuery.trim().length >= 2) {
      filters.search = debouncedQuery.trim();
    }
    if (countryFilter) {
      filters.countryCode = countryFilter;
    }
    if (typeFilter) {
      filters.partyType = typeFilter;
    }
    if (sellerFilter.trim().length >= 1) {
      filters.sellerName = sellerFilter.trim();
    }
    return filters;
  }, [partyIdFilter, debouncedQuery, countryFilter, typeFilter, sellerFilter]);

  // Define fetchParties early so it can be used in useEffect
  const fetchParties = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();

      // Priority: party ID filter overrides all other filters
      if (partyIdFilter) {
        params.append('id', partyIdFilter);
      } else {
        // Apply other filters only if not filtering by ID
        if (debouncedQuery.length >= 2) {
          params.append('search', debouncedQuery);
        }

        if (countryFilter) {
          params.append('country_code', countryFilter);
        }
        if (typeFilter) {
          params.append('type', typeFilter);
        }
        if (sellerFilter.trim().length >= 1) {
          params.append('seller_name', sellerFilter.trim());
        }
      }

      params.append('page', String(pagination.page));
      params.append('limit', String(pagination.limit));

      const response = await fetch(`/api/parties?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch parties');

      const data = await response.json();
      const normalizedParties: Party[] = (Array.isArray(data.parties) ? data.parties : []).map((party: ApiPartyResponse) => ({
        ...party,
        partyType: party.partyType,
        transactionCode: party.transactionCode ?? null,
        sellerId: party.sellerId ?? null,
        seller: party.seller
          ? {
              id: party.seller.id,
              displayName: party.seller.displayName,
              tinDisplay: party.seller.tinDisplay
            }
          : null
      }));
      setParties(normalizedParties);
      setPagination(data.pagination);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [partyIdFilter, debouncedQuery, countryFilter, typeFilter, sellerFilter, pagination.limit, pagination.page]);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch parties
  useEffect(() => {
    fetchParties();
  }, [fetchParties]);

  useEffect(() => {
    const fetchTransactionCodes = async () => {
      try {
        const response = await fetch('/api/transaction-codes');

        if (!response.ok) {
          throw new Error('Failed to fetch transaction codes');
        }

        const rawCodes = await response.json();
        const normalizedCodes: TransactionCode[] = (rawCodes || []).map((code: ApiTransactionCode) => ({
          code: code.code,
          name: code.name,
          description: code.description ?? ''
        }));

        setTransactionCodes(normalizedCodes);
        setTransactionCodesError(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load transaction codes';
        console.error(message, err);
        setTransactionCodesError(message);
      }
    };

    fetchTransactionCodes();
  }, []);

  const fetchSellersList = async () => {
    try {
      setSellersLoading(true);
      const params = new URLSearchParams({
        type: 'seller',
        limit: '200'
      });
      const response = await fetch(`/api/parties?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch sellers');
      }
      const data = await response.json();
      const normalized: SellerOption[] = (data.parties || [])
        .map((party: ApiPartyResponse) => ({
          id: party.id,
          displayName: party.displayName,
          tinDisplay: party.tinDisplay
        }))
        .sort((a: SellerOption, b: SellerOption) => a.displayName.localeCompare(b.displayName));
      setSellers(normalized);
    } catch (err) {
      console.error('Failed to load sellers', err);
    } finally {
      setSellersLoading(false);
    }
  };

  useEffect(() => {
    fetchSellersList();
  }, []);

  const showToast = (message: ReactNode, type: 'success' | 'error' = 'success', undo?: () => void) => {
    setToast({ message, type, undo });
    if (!undo) {
      setTimeout(() => setToast(null), 3000);
    }
  };

  useEffect(() => {
    // When filters change:
    // - Reset individually selected IDs (only relevant for current filter state)
    // - Preserve "select all except" state across filters
    // - Reset selection snapshot (will be recaptured if user clicks "Select All")
    if (!allSelected) {
      setSelectedIds(new Set());
    }
    setSelectionFiltersSnapshot(null);
    setPagination(prev => ({ ...prev, page: 1 }));
  }, [partyIdFilter, debouncedQuery, countryFilter, typeFilter, sellerFilter]);

  const isRowSelected = (partyId: string) => {
    return allSelected ? !excludedIds.has(partyId) : selectedIds.has(partyId);
  };

  const visiblePartyIds = useMemo(() => parties.map(party => party.id), [parties]);

  const areAllVisibleSelected = useMemo(() => {
    if (parties.length === 0) return false;
    if (allSelected) {
      return parties.every(party => !excludedIds.has(party.id));
    }
    return parties.every(party => selectedIds.has(party.id));
  }, [parties, allSelected, excludedIds, selectedIds]);

  const selectedCount = useMemo(() => {
    if (allSelected) {
      return Math.max(0, pagination.totalCount - excludedIds.size);
    }
    return selectedIds.size;
  }, [allSelected, pagination.totalCount, excludedIds, selectedIds]);

  const hasSelection = selectedCount > 0;

  const clearSelection = () => {
    setSelectedIds(new Set());
    setExcludedIds(new Set());
    setAllSelected(false);
    setSelectionFiltersSnapshot(null);
  };

  const invertSelection = () => {
    if (allSelected) {
      // In "select all" mode: invert means select only the excluded items
      setSelectedIds(new Set(excludedIds));
      setExcludedIds(new Set());
      setAllSelected(false);
      setSelectionFiltersSnapshot(null);
    } else {
      // In individual selection mode: invert means select all except currently selected
      setAllSelected(true);
      setExcludedIds(new Set(selectedIds));
      setSelectedIds(new Set());
      setSelectionFiltersSnapshot(currentFilters);
    }
  };

  const toggleRowSelection = (partyId: string) => {
    if (allSelected) {
      setExcludedIds(prev => {
        const next = new Set(prev);
        if (next.has(partyId)) {
          next.delete(partyId);
        } else {
          next.add(partyId);
        }
        return next;
      });
      return;
    }
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(partyId)) {
        next.delete(partyId);
      } else {
        next.add(partyId);
      }
      return next;
    });
  };

  const toggleVisibleSelection = () => {
    if (visiblePartyIds.length === 0) return;
    if (areAllVisibleSelected) {
      if (allSelected) {
        setExcludedIds(prev => {
          const next = new Set(prev);
          visiblePartyIds.forEach(id => next.add(id));
          return next;
        });
      } else {
        setSelectedIds(prev => {
          const next = new Set(prev);
          visiblePartyIds.forEach(id => next.delete(id));
          return next;
        });
      }
      return;
    }

    if (allSelected) {
      setExcludedIds(prev => {
        const next = new Set(prev);
        visiblePartyIds.forEach(id => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        visiblePartyIds.forEach(id => next.add(id));
        return next;
      });
    }
  };

  const handleSelectAllResults = () => {
    setAllSelected(true);
    setExcludedIds(new Set());
    setSelectionFiltersSnapshot(currentFilters);
  };

  const buildSelectionPayload = (): PartySelectionPayload | null => {
    if (allSelected) {
      return {
        mode: 'filters',
        filters: selectionFiltersSnapshot || currentFilters,
        excludeIds: Array.from(excludedIds)
      };
    }

    if (selectedIds.size === 0) {
      return null;
    }

    return {
      mode: 'ids',
      ids: Array.from(selectedIds)
    };
  };

  const handleBulkDelete = async () => {
    const selection = buildSelectionPayload();
    if (!selection) {
      showToast('Select at least one party to delete', 'error');
      return;
    }

    const confirmed = window.confirm('Delete selected parties? This action can be undone for single deletions but not for bulk actions.');
    if (!confirmed) return;

    try {
      const response = await fetch('/api/parties/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selection })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Failed to delete parties');
      }

      const result = await response.json();
      showToast(`Deleted ${result.deleted} parties`);
      clearSelection();
      await fetchParties();
      await fetchSellersList();
      await fetchSellersList();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete parties', 'error');
    }
  };

  const handleBulkExport = async () => {
    const selection = buildSelectionPayload();
    if (!selection) {
      showToast('Select parties to export', 'error');
      return;
    }

    try {
      const response = await fetch('/api/parties/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selection })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Failed to export parties');
      }

      const blob = await response.blob();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `parties-export-${timestamp}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to export parties', 'error');
    }
  };

  const handleImportFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setImporting(true);
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/parties/import', {
        method: 'POST',
        body: formData
      });

      // Try to parse response as JSON, with fallback for empty responses
      let result;
      try {
        const text = await response.text();
        if (!text) {
          throw new Error('Empty response from server');
        }
        result = JSON.parse(text);
      } catch (parseErr) {
        console.error('Failed to parse server response:', parseErr);
        throw new Error('Server returned invalid response. Please check the server logs.');
      }

      if (!response.ok && !result.summary) {
        throw new Error(result.error?.message || 'Failed to import CSV');
      }

      const summary = result.summary || { created: 0, updated: 0, failed: 0 };
      const message = `Import complete — ${summary.created} created, ${summary.updated} updated${summary.failed ? `, ${summary.failed} failed` : ''}`;
      showToast(message, result.error || summary.failed ? 'error' : 'success');

      // Show general import error if there was a server error
      if (result.error) {
        showToast(
          <>
            <div className="font-medium mb-2">Import Error: {result.error.code}</div>
            <div className="text-xs whitespace-pre-wrap">{result.error.message}</div>
          </>,
          'error'
        );
      }

      // Show update details if there are any
      if (result.updateDetails?.length) {
        const updateSummary = result.updateDetails
          .map((detail: any) => `Row ${detail.rowNumber}: ${detail.displayName} → ${detail.existingPartyName}`)
          .join('\n');
        showToast(
          <>
            <div className="font-medium mb-2">Updated {result.updateDetails.length} party/parties due to duplicates:</div>
            <div className="text-xs whitespace-pre-wrap max-h-48 overflow-y-auto">{updateSummary}</div>
            <button
              onClick={() => {
                const detailText = result.updateDetails
                  .map((detail: any) => `Row ${detail.rowNumber}:\n  Party: ${detail.displayName}\n  Reason: ${detail.reason}\n  Updated: ${detail.existingPartyName}\n`)
                  .join('\n');
                showToast(
                  <>
                    <div className="font-medium mb-2">Update Details</div>
                    <div className="text-xs whitespace-pre-wrap max-h-96 overflow-y-auto">{detailText}</div>
                  </>,
                  'info'
                );
              }}
              className="mt-2 px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded hover:bg-blue-200 transition-colors"
            >
              More Info
            </button>
          </>,
          'info'
        );
      }

      if (result.errors?.length) {
        console.warn('Import errors:', result.errors);
        // Show error details
        const errorDetails = result.errors
          .map((err: { rowNumber: number; message: string }) => `Row ${err.rowNumber}: ${err.message}`)
          .join('\n');
        showToast(
          <>
            <div className="font-medium mb-2">Import failed for {result.errors.length} row(s):</div>
            <div className="text-xs whitespace-pre-wrap max-h-64 overflow-y-auto">{errorDetails}</div>
          </>,
          'error'
        );
      }

      clearSelection();
      await fetchParties();
    } catch (err) {
      console.error('Import error:', err);
      showToast(err instanceof Error ? err.message : 'Failed to import CSV', 'error');
    } finally {
      setImporting(false);
      event.target.value = '';
    }
  };

  const handleAddParty = async (partyData: PartyPayloadInput) => {
    try {
      const response = await fetch('/api/parties', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partyData)
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Failed to add party');
      }

      await fetchParties();
      await fetchSellersList();
      setShowAddForm(false);
      showToast('Party created successfully');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to add party', 'error');
    }
  };

  const handleUpdateParty = async (partyId: string, field: string, value: string, originalParty: Party) => {
    try {
      const updateData = {
        ...originalParty,
        [field]: value || null,
        updatedAt: originalParty.updatedAt // For optimistic concurrency
      };
      delete (updateData as { seller?: SellerOption | null }).seller;

      const response = await fetch(`/api/parties/${partyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData)
      });

      if (!response.ok) {
        const errorData = await response.json();

        // Handle conflict
        if (errorData.error?.code === 'CONFLICT') {
          const confirmed = window.confirm(
            `${errorData.error.message}\n\nWould you like to refresh and see the current version?`
          );
          if (confirmed) {
            await fetchParties();
          }
          throw new Error(errorData.error.message);
        }

        throw new Error(errorData.error?.message || 'Failed to update party');
      }

      await fetchParties();
      await fetchSellersList();
      setEditingCell(null);
      showToast(`Party "${originalParty.displayName}" updated`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update party', 'error');
    }
  };

  const handleDeleteParty = async (party: Party) => {
    try {
      // Optimistically remove from UI
      const previousParties = [...parties];
      setParties(prev => prev.filter(p => p.id !== party.id));

      // Show undo toast
      let undone = false;
      const undoDelete = async () => {
        if (!undone) {
          undone = true;
          setParties(previousParties);
          setToast(null);

          // Call restore API
          try {
            await fetch(`/api/parties/${party.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'restore' })
            });
            showToast(`Party "${party.displayName}" restored`);
          } catch {
            showToast('Failed to restore party', 'error');
            await fetchParties();
          }
        }
      };

      setToast({
        message: (
          <div className="flex items-center gap-3">
            <span>
              Deleted &ldquo;{party.displayName}&rdquo;
            </span>
            <button
              onClick={undoDelete}
              className="underline font-medium hover:no-underline"
            >
              Undo
            </button>
          </div>
        ),
        type: 'success',
        undo: undoDelete
      });

      // Actually delete after 5 seconds if not undone
      setTimeout(async () => {
        if (!undone) {
          try {
            const response = await fetch(`/api/parties/${party.id}`, {
              method: 'DELETE'
            });

            if (!response.ok) {
              const errorData = await response.json();
              throw new Error(errorData.error?.message || 'Failed to delete party');
            }

            setToast(null);
            await fetchParties();
            await fetchSellersList();
          } catch (err) {
            showToast(err instanceof Error ? err.message : 'Failed to delete party', 'error');
            setParties(previousParties);
          }
        }
      }, 5000);

    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete party', 'error');
    }
  };

  const startEditing = (partyId: string, field: string, currentValue: string) => {
    setEditingCell({ partyId, field });
    setEditValue(currentValue || '');
  };

  const cancelEditing = () => {
    setEditingCell(null);
    setEditValue('');
  };

  const saveEdit = (party: Party, overrideValue?: string) => {
    if (editingCell) {
      const valueToSave = overrideValue !== undefined ? overrideValue : editValue;
      handleUpdateParty(party.id, editingCell.field, valueToSave, party);
    }
  };

  const uniqueCountries = Array.from(new Set(parties.map(p => p.countryCode).filter(Boolean) as string[])).sort();

  if (loading && parties.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">Loading parties...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        className="hidden"
        onChange={handleImportFileChange}
      />
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 bg-white border-b shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <h1 className="text-2xl font-bold text-gray-900">Company Directory</h1>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 bg-gray-100 text-gray-800 rounded-lg hover:bg-gray-200 transition-colors font-medium text-sm border border-gray-200"
                disabled={importing}
              >
                {importing ? 'Importing...' : 'Import CSV'}
              </button>
              <button
                onClick={() => setShowAddForm(!showAddForm)}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium text-sm"
                aria-label="Add new company"
              >
                + Add Party
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div className="flex-1 min-w-[220px]">
              <label htmlFor="party-search" className="sr-only">
                Search companies by name or TIN
              </label>
              <input
                id="party-search"
                type="search"
                placeholder="Search by name or TIN..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                aria-describedby="search-help"
              />
              <span id="search-help" className="sr-only">
                Filter parties by display name or TIN
              </span>
            </div>

            <div>
              <label htmlFor="country-filter" className="sr-only">
                Filter by country
              </label>
              <select
                id="country-filter"
                value={countryFilter}
                onChange={(e) => setCountryFilter(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All Countries</option>
                {uniqueCountries.map(country => (
                  <option key={country} value={country}>
                    {country}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="type-filter" className="sr-only">
                Filter by type
              </label>
              <select
                id="type-filter"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as PartyRole | '')}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All Types</option>
                <option value="buyer">Buyers</option>
                <option value="seller">Sellers</option>
              </select>
            </div>

            <div className="flex-1 min-w-[200px]">
              <label htmlFor="seller-filter" className="sr-only">
                Filter by seller name
              </label>
              <input
                id="seller-filter"
                type="text"
                placeholder="Filter by seller name"
                value={sellerFilter}
                onChange={(e) => setSellerFilter(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="flex items-center gap-4 text-sm text-gray-600 ml-auto">
              <span className="font-medium">
                {pagination.totalCount} {pagination.totalCount === 1 ? 'Party' : 'Parties'}
              </span>
            </div>
          </div>

          {/* Keyboard shortcuts hint */}
          <div className="mt-2 text-xs text-gray-500">
            <kbd className="px-1.5 py-0.5 bg-gray-100 rounded">Tab</kbd> to navigate •{' '}
            <kbd className="px-1.5 py-0.5 bg-gray-100 rounded">Enter</kbd> to save •{' '}
            <kbd className="px-1.5 py-0.5 bg-gray-100 rounded">Esc</kbd> to cancel
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
            {error}
          </div>
        )}

        {transactionCodesError && (
          <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-700">
            {transactionCodesError}. Transaction code editing is temporarily unavailable.
          </div>
        )}

        {/* Add Party Form */}
        {showAddForm && (
          <AddPartyForm
            onClose={() => setShowAddForm(false)}
            onSuccess={handleAddParty}
            onError={(msg) => showToast(msg, 'error')}
            transactionCodes={transactionCodes}
            sellers={sellers}
            sellersLoading={sellersLoading}
          />
        )}

        {hasSelection && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3">
            <div className="flex-1">
              <p className="text-sm font-medium text-blue-900">
                {allSelected ? (
                  <span>{selectedCount} results selected</span>
                ) : (
                  <span>{selectedCount} selected</span>
                )}
              </p>
              <div className="flex flex-wrap gap-4 mt-2">
                {!allSelected && pagination.totalCount > selectedCount && (
                  <button
                    onClick={handleSelectAllResults}
                    className="text-xs text-blue-700 hover:underline font-medium"
                  >
                    Select all {pagination.totalCount} results across all pages
                  </button>
                )}
                {allSelected && (
                  <button
                    onClick={clearSelection}
                    className="text-xs text-blue-700 hover:underline font-medium"
                  >
                    Deselect all
                  </button>
                )}
                {hasSelection && (
                  <button
                    onClick={invertSelection}
                    className="text-xs text-blue-700 hover:underline font-medium"
                  >
                    Invert Selection
                  </button>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleBulkExport}
                className="px-3 py-2 text-sm font-medium text-blue-700 bg-white border border-blue-200 rounded-lg hover:bg-blue-100"
              >
                Export Selected
              </button>
              <button
                onClick={handleBulkDelete}
                className="px-3 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700"
              >
                Delete Selected
              </button>
            </div>
          </div>
        )}

        {/* Parties Table */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200" aria-label="Company directory">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3">
                    <div className="flex items-center group relative">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        checked={areAllVisibleSelected && parties.length > 0}
                        onChange={toggleVisibleSelection}
                        aria-label={allSelected ? "Deselect visible parties from all" : "Select visible parties"}
                        title={allSelected ?
                          "Uncheck to exclude visible parties from 'all selected'" :
                          "Check to select all visible parties on this page"
                        }
                      />
                      {allSelected && (
                        <span className="ml-1 text-xs text-blue-600 font-semibold" title="In 'select all' mode">
                          ✓ All
                        </span>
                      )}
                    </div>
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Company Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Seller
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    TIN
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Country
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Transaction Code
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Email
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Document
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Document Number
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    IDTKU
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Address
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-100">
                {parties.map((party) => (
                  <PartyRow
                    key={party.id}
                    party={party}
                    editingCell={editingCell}
                    editValue={editValue}
                    onStartEdit={startEditing}
                    onCancelEdit={cancelEditing}
                    onSaveEdit={saveEdit}
                    onEditValueChange={setEditValue}
                    transactionCodes={transactionCodes}
                    sellers={sellers}
                    sellersLoading={sellersLoading}
                    isSelected={isRowSelected(party.id)}
                    onToggleSelect={toggleRowSelection}
                    allSelected={allSelected}
                    isExcluded={excludedIds.has(party.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {parties.length === 0 && !loading && (
            <div className="text-center py-12">
              <div className="text-gray-500 mb-4">
                {searchQuery || countryFilter
                  ? 'No parties found matching your search'
                  : 'No parties registered yet'}
              </div>
              {!searchQuery && !countryFilter && (
                <button
                  onClick={() => setShowAddForm(true)}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium text-sm"
                >
                  + Add your first party
                </button>
              )}
            </div>
          )}

          {/* Pagination Controls */}
          {pagination.totalPages > 1 && (
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
              <div className="text-sm text-gray-600">
                Page {pagination.page} of {pagination.totalPages}
                {' • '}
                Showing {parties.length} of {pagination.totalCount} parties
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
                  disabled={pagination.page === 1}
                  className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
                  disabled={!pagination.hasMore}
                  className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
      <div className="fixed bottom-4 right-4 z-50">
        <div
          className={`px-6 py-3 rounded-lg shadow-lg ${
            toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
          } text-white min-w-[300px]`}
        >
          {toast.message}
        </div>
      </div>
    )}
    </div>
  );
}

// PartyRow Component
function PartyRow({
  party,
  editingCell,
  editValue,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onEditValueChange,
  transactionCodes,
  sellers,
  sellersLoading,
  isSelected,
  onToggleSelect,
  allSelected,
  isExcluded
}: {
  party: Party;
  editingCell: { partyId: string; field: string } | null;
  editValue: string;
  onStartEdit: (partyId: string, field: string, currentValue: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (party: Party, overrideValue?: string) => void;
  onEditValueChange: (value: string) => void;
  transactionCodes: TransactionCode[];
  sellers: SellerOption[];
  sellersLoading: boolean;
  isSelected: boolean;
  onToggleSelect: (partyId: string) => void;
  allSelected: boolean;
  isExcluded: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLDivElement>(null);
  const addressSpanRef = useRef<HTMLSpanElement>(null);
  const [hoveredAddress, setHoveredAddress] = useState<{
    partyId: string;
    position: 'top' | 'bottom';
  } | null>(null);

  useEffect(() => {
    if (editingCell && editingCell.partyId === party.id && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingCell, party.id]);

  const isEditing = (field: string) =>
    editingCell?.partyId === party.id && editingCell?.field === field;

  const isAddressTextTruncated = (): boolean => {
    const span = addressSpanRef.current;
    if (!span) return false;
    return span.scrollWidth - span.clientWidth > 0.5;
  };

  const handleAddressMouseEnter = () => {
    if (!party.addressFull) {
      return;
    }

    if (!isAddressTextTruncated()) {
      setHoveredAddress(null);
      return;
    }

    const container = addressRef.current;
    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const viewportHeight = typeof window !== 'undefined'
      ? window.innerHeight || document.documentElement.clientHeight || 0
      : 0;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;
    const preferTop = spaceBelow < 150 && spaceAbove > spaceBelow;

    setHoveredAddress({
      partyId: party.id,
      position: preferTop ? 'top' : 'bottom'
    });
  };

  const handleAddressMouseLeave = () => {
    setHoveredAddress(null);
  };

  const renderTransactionCodeCell = () => {
    const activeValue = isEditing('transactionCode') ? editValue || '' : party.transactionCode || '';
    const selectedCode = transactionCodes.find(code => code.code === activeValue);
    const fallbackText = activeValue ? activeValue.padStart(2, '0') : null;
    const displayText = selectedCode
      ? `${selectedCode.code.padStart(2, '0')} – ${selectedCode.name}`
      : fallbackText
        ? fallbackText
        : <span className="text-gray-400 italic">—</span>;

    if (!isEditing('transactionCode') || transactionCodes.length === 0) {
      const canEdit = transactionCodes.length > 0;

      return (
        <div
          onClick={() => canEdit && onStartEdit(party.id, 'transactionCode', party.transactionCode || '')}
          className={`${canEdit ? 'cursor-pointer hover:bg-gray-50' : ''} px-2 py-1 rounded min-h-[32px] text-sm text-gray-700`}
          role={canEdit ? 'button' : undefined}
          tabIndex={canEdit ? 0 : undefined}
          aria-label={canEdit ? `Edit transaction code for ${party.displayName}` : undefined}
        >
          {displayText}
        </div>
      );
    }

    return (
      <div className="min-w-[220px]">
        <TransactionCodeDropdown
          codes={transactionCodes}
          selectedCode={editValue || null}
          onChange={(code) => {
            onEditValueChange(code);
            onSaveEdit(party, code);
          }}
          compact
        />
      </div>
    );
  };

  const renderTypeCell = () => {
    if (!isEditing('partyType')) {
      const label = party.partyType === 'seller' ? 'Seller' : 'Buyer';
      const badgeClass =
        party.partyType === 'seller'
          ? 'bg-orange-100 text-orange-800'
          : 'bg-green-100 text-green-800';

      return (
        <button
          type="button"
          onClick={() => onStartEdit(party.id, 'partyType', party.partyType)}
          className="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold hover:bg-gray-100"
        >
          <span className={badgeClass + ' px-2 py-0.5 rounded-full'}>
            {label}
          </span>
        </button>
      );
    }

    const value = editValue || party.partyType;
    return (
      <select
        value={value}
        onChange={(e) => {
          onEditValueChange(e.target.value);
          onSaveEdit(party, e.target.value);
        }}
        onBlur={() => onCancelEdit()}
        className="px-2 py-1 border border-blue-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
      >
        <option value="buyer">Buyer</option>
        <option value="seller">Seller</option>
      </select>
    );
  };

  const renderSellerCell = () => {
    if (party.partyType === 'seller') {
      return <span className="text-gray-400 text-sm italic">—</span>;
    }

    if (!isEditing('sellerId')) {
      return (
        <div
          onClick={() => onStartEdit(party.id, 'sellerId', party.sellerId || '')}
          className="cursor-pointer hover:bg-gray-50 px-2 py-1 rounded min-h-[32px]"
        >
          {party.seller ? (
            <div>
              <p className="text-sm font-medium text-gray-900">{party.seller.displayName}</p>
              <p className="text-xs text-gray-500">{party.seller.tinDisplay}</p>
            </div>
          ) : (
            <span className="text-sm text-gray-400 italic">Unlinked</span>
          )}
        </div>
      );
    }

    const value = editValue || party.sellerId || '';
    return (
      <select
        value={value}
        onChange={(e) => {
          onEditValueChange(e.target.value);
          onSaveEdit(party, e.target.value);
        }}
        onBlur={() => onCancelEdit()}
        disabled={sellersLoading}
        className="w-full px-2 py-1 border border-blue-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="">Unlinked</option>
        {sellers.map((seller) => (
          <option key={seller.id} value={seller.id}>
            {seller.displayName} ({seller.tinDisplay})
          </option>
        ))}
      </select>
    );
  };

  const renderCell = (field: keyof Party, value: string | null, editable: boolean = true) => {
    if (!editable || !isEditing(field)) {
      return (
        <div
          onClick={() => editable && onStartEdit(party.id, field, value || '')}
          className={`${editable ? 'cursor-pointer hover:bg-gray-50' : ''} px-2 py-1 rounded min-h-[32px]`}
          role={editable ? 'button' : undefined}
          tabIndex={editable ? 0 : undefined}
          aria-label={editable ? `Edit ${field} for ${party.displayName}` : undefined}
        >
          {field === 'addressFull' && value && value.length > 50 ? (
            <span title={value}>{value.substring(0, 50)}...</span>
          ) : (
            <span>{value || <span className="text-gray-400 italic">—</span>}</span>
          )}
        </div>
      );
    }

    return (
      <input
        ref={inputRef}
        type="text"
        value={editValue}
        onChange={(e) => onEditValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onSaveEdit(party);
          } else if (e.key === 'Escape') {
            onCancelEdit();
          }
        }}
        onBlur={() => onSaveEdit(party)}
        className="w-full px-2 py-1 border border-blue-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    );
  };

  return (
    <tr className={`hover:bg-gray-50 ${isSelected ? 'bg-blue-50/30' : ''} ${isExcluded && allSelected ? 'opacity-60' : ''}`}>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            className={`h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 ${
              isExcluded && allSelected ? 'opacity-50' : ''
            }`}
            checked={isSelected}
            onChange={() => onToggleSelect(party.id)}
            aria-label={
              allSelected
                ? isExcluded
                  ? `Include ${party.displayName} in selection`
                  : `Exclude ${party.displayName} from selection`
                : `Select ${party.displayName}`
            }
            title={
              allSelected
                ? isExcluded
                  ? 'Click to include in "select all"'
                  : 'Click to exclude from "select all"'
                : undefined
            }
          />
          {isExcluded && allSelected && (
            <span className="text-xs text-gray-400 font-medium" title="Excluded from 'select all'">
              ✕
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="font-medium text-gray-900">{renderCell('displayName', party.displayName)}</div>
      </td>
      <td className="px-4 py-3">
        {renderTypeCell()}
      </td>
      <td className="px-4 py-3">
        {renderSellerCell()}
      </td>
      <td className="px-4 py-3">
        <code className="text-sm text-gray-700">
          {renderCell('tinDisplay', party.tinDisplay)}
        </code>
      </td>
      <td className="px-4 py-3">
        <span className="text-sm text-gray-700">
          {renderCell('countryCode', party.countryCode)}
        </span>
      </td>
      <td className="px-4 py-3">
        {renderTransactionCodeCell()}
      </td>
      <td className="px-4 py-3">
        <span className="text-sm text-gray-700">
          {renderCell('email', party.email)}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="text-sm text-gray-700">
          {renderCell('buyerDocument', party.buyerDocument)}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="text-sm text-gray-700">
          {renderCell('buyerDocumentNumber', party.buyerDocumentNumber)}
        </span>
      </td>
      <td className="px-4 py-3">
        <code className="text-xs text-gray-600">
          {renderCell('buyerIdtku', party.buyerIdtku)}
        </code>
      </td>
      <td className="px-4 py-3">
        <div
          ref={addressRef}
          className="relative"
          onMouseEnter={handleAddressMouseEnter}
          onMouseLeave={handleAddressMouseLeave}
        >
          {isEditing('addressFull') ? (
            // Edit mode - expanded input that fits content (expands to the left)
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => onEditValueChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onSaveEdit(party);
                } else if (e.key === 'Escape') {
                  onCancelEdit();
                }
              }}
              onBlur={() => onSaveEdit(party)}
              className="absolute right-0 top-0 z-40 bg-white shadow-lg rounded border border-blue-300 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              style={{
                minWidth: '200px',
                width: `calc(${editValue.length * 8.5}px + 32px)`,
                maxWidth: 'min(90vw, calc(100vw - 40px))'
              }}
            />
          ) : (
            // View mode - truncated with tooltip
            <>
              <span
                ref={addressSpanRef}
                className="text-sm text-gray-700 block truncate max-w-xs cursor-pointer hover:bg-gray-50 px-2 py-1 rounded"
                onClick={() => onStartEdit(party.id, 'addressFull', party.addressFull || '')}
                role="button"
                tabIndex={0}
                aria-label={`Edit address for ${party.displayName}`}
              >
                {party.addressFull || <span className="text-gray-400 italic">—</span>}
              </span>
              {hoveredAddress?.partyId === party.id && party.addressFull && (
                <div
                  className={`absolute right-0 ${
                    hoveredAddress.position === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'
                  } z-40 w-max max-w-sm rounded-md border border-gray-200 bg-white p-2 text-xs leading-relaxed text-gray-700 shadow-lg`}
                  role="tooltip"
                >
                  <span className="whitespace-pre-wrap break-words">{party.addressFull}</span>
                </div>
              )}
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

// AddPartyForm Component
function AddPartyForm({
  onClose,
  onSuccess,
  onError,
  transactionCodes,
  sellers,
  sellersLoading
}: {
  onClose: () => void;
  onSuccess: (data: PartyPayloadInput) => void;
  onError: (message: string) => void;
  transactionCodes: TransactionCode[];
  sellers: SellerOption[];
  sellersLoading: boolean;
}) {
  const [displayName, setDisplayName] = useState('');
  const [tinDisplay, setTinDisplay] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [email, setEmail] = useState('');
  const [addressFull, setAddressFull] = useState('');
  const [buyerDocument, setBuyerDocument] = useState('TIN');
  const [buyerDocumentNumber, setBuyerDocumentNumber] = useState('');
  const [buyerIdtku, setBuyerIdtku] = useState('');
  const [transactionCode, setTransactionCode] = useState<string | null>(null);
  const [partyType, setPartyType] = useState<PartyRole>('buyer');
  const [sellerId, setSellerId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const displayNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    displayNameRef.current?.focus();
  }, []);

  useEffect(() => {
    if (partyType === 'seller') {
      setSellerId('');
    }
  }, [partyType]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!displayName.trim() || !tinDisplay.trim()) {
      onError('Company name and TIN are required');
      return;
    }

    try {
      setSubmitting(true);
      await onSuccess({
        displayName: displayName.trim(),
        tinDisplay: tinDisplay.trim(),
        countryCode: countryCode.trim() || null,
        transactionCode: transactionCode || null,
        email: email.trim() || null,
        addressFull: addressFull.trim() || null,
        buyerDocument: buyerDocument.trim() || null,
        buyerDocumentNumber: buyerDocumentNumber.trim() || null,
        buyerIdtku: buyerIdtku.trim() || null,
        partyType,
        sellerId: partyType === 'buyer' ? (sellerId || null) : null
      });

      // Reset form
      setDisplayName('');
      setTinDisplay('');
      setCountryCode('');
      setTransactionCode(null);
      setEmail('');
      setAddressFull('');
      setBuyerDocument('TIN');
      setBuyerDocumentNumber('');
      setBuyerIdtku('');
      setPartyType('buyer');
      setSellerId('');
    } catch {
      // Error handled by parent
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="mb-6 p-6 bg-blue-50 border border-blue-200 rounded-lg" onKeyDown={handleKeyDown}>
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Add New Party</h3>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="party-name" className="block text-sm font-medium text-gray-700 mb-1">
              Company Name <span className="text-red-500">*</span>
            </label>
            <input
              ref={displayNameRef}
              id="party-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="ABC Corporation"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
              maxLength={255}
            />
          </div>
          <div>
            <label htmlFor="party-tin" className="block text-sm font-medium text-gray-700 mb-1">
              TIN <span className="text-red-500">*</span>
            </label>
            <input
              id="party-tin"
              type="text"
              value={tinDisplay}
              onChange={(e) => setTinDisplay(e.target.value)}
              placeholder="12.345.678/0001-90"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
              maxLength={50}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <span className="block text-sm font-medium text-gray-700 mb-2">Party Type</span>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="party-type"
                  value="buyer"
                  checked={partyType === 'buyer'}
                  onChange={() => setPartyType('buyer')}
                />
                Buyer
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="party-type"
                  value="seller"
                  checked={partyType === 'seller'}
                  onChange={() => setPartyType('seller')}
                />
                Seller
              </label>
            </div>
          </div>
          {partyType === 'buyer' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Linked Seller
              </label>
              <select
                value={sellerId}
                onChange={(e) => setSellerId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={sellersLoading}
              >
                <option value="">Unlinked</option>
                {sellers.map((seller) => (
                  <option key={seller.id} value={seller.id}>
                    {seller.displayName} ({seller.tinDisplay})
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">Optional. Use when buyer reports for a specific seller.</p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label htmlFor="party-country" className="block text-sm font-medium text-gray-700 mb-1">
              Country Code
            </label>
            <input
              id="party-country"
              type="text"
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
              placeholder="USA, BRA, IDN"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              maxLength={3}
              pattern="[A-Z]{3}"
            />
            <p className="text-xs text-gray-500 mt-1">3-letter uppercase ISO code</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Transaction Code
            </label>
            <TransactionCodeDropdown
              codes={transactionCodes}
              selectedCode={transactionCode}
              onChange={(code) => setTransactionCode(code)}
              compact
            />
            <p className="text-xs text-gray-500 mt-1">Helps categorize invoices and reporting.</p>
          </div>
          <div>
            <label htmlFor="party-email" className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              id="party-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="contact@company.com"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              maxLength={255}
            />
          </div>
        </div>

        <div>
          <label htmlFor="party-address" className="block text-sm font-medium text-gray-700 mb-1">
            Address
          </label>
          <textarea
            id="party-address"
            value={addressFull}
            onChange={(e) => setAddressFull(e.target.value)}
            placeholder="Full address..."
            rows={2}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            maxLength={1000}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label htmlFor="buyer-document" className="block text-sm font-medium text-gray-700 mb-1">
              Document
            </label>
            <input
              id="buyer-document"
              type="text"
              value={buyerDocument}
              onChange={(e) => setBuyerDocument(e.target.value)}
              placeholder="TIN"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              maxLength={50}
            />
            <p className="text-xs text-gray-500 mt-1">Defaults to &ldquo;TIN&rdquo;, can be edited or cleared</p>
          </div>
          <div>
            <label htmlFor="buyer-document-number" className="block text-sm font-medium text-gray-700 mb-1">
              Document Number
            </label>
            <input
              id="buyer-document-number"
              type="text"
              value={buyerDocumentNumber}
              onChange={(e) => setBuyerDocumentNumber(e.target.value)}
              placeholder="Optional"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              maxLength={100}
            />
          </div>
          <div>
            <label htmlFor="buyer-idtku" className="block text-sm font-medium text-gray-700 mb-1">
              IDTKU
            </label>
            <input
              id="buyer-idtku"
              type="text"
              value={buyerIdtku}
              onChange={(e) => setBuyerIdtku(e.target.value)}
              placeholder="Auto-calculated from TIN"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              maxLength={100}
            />
            <p className="text-xs text-gray-500 mt-1">Leave empty to auto-calculate (TIN + 000000)</p>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            disabled={submitting}
          >
            {submitting ? 'Creating...' : 'Create Party'}
          </button>
        </div>
      </form>
    </div>
  );
}
