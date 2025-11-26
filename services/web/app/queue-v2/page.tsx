'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AddPartyForm, { PartyPayloadInput, SellerOption, TransactionCode } from '@/components/party/AddPartyForm';

type InvoiceStatus = 'complete' | 'processing' | 'error' | 'incomplete';
type SelectionMode = 'none' | 'page' | 'all';
type SortField = 'date' | 'invoice_number' | 'buyer_name';
type SortDirection = 'asc' | 'desc';

interface Invoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  trxCode: string | null;
  sellerName: string;
  buyerName: string | null;
  buyerPartyId: string | null;
  status: InvoiceStatus;
  isComplete: boolean;
  missingFields: string[];
}

interface SelectionState {
  mode: SelectionMode;
  selectedIds: Set<string>;
  excludedIds: Set<string>;
}

interface FilterState {
  buyerPartyId: string | null;
  // Future filters (commented out for now):
  // status: string | null;
  // invoiceNumber: string | null;
  // month: string | null; // YYYY-MM format
}

interface SortState {
  field: SortField;
  direction: SortDirection;
}

interface Buyer {
  id: string;
  name: string;
}

interface PartyOption {
  id: string;
  displayName: string;
  partyType: 'buyer' | 'seller';
  tinDisplay: string;
}

interface UndoSnapshot {
  id: string;
  buyer_party_id: string | null;
  buyer_name: string | null;
  buyer_tin: string | null;
  buyer_document: string | null;
  buyer_country: string | null;
  buyer_document_number: string | null;
  buyer_address: string | null;
  buyer_email: string | null;
  buyer_idtku: string | null;
  trx_code: string | null;
  missing_fields: string[] | null;
  is_complete: boolean | null;
  tax_invoice_date?: string | null;
}

type BannerState = {
  type: 'success' | 'error';
  message: string;
  onUndo?: () => void;
};

const STATUS_STYLES: Record<InvoiceStatus, { bg: string; text: string; border: string; label: string }> = {
  complete: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', label: 'Complete' },
  processing: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', label: 'Processing' },
  error: { bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-200', label: 'Error' },
  incomplete: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', label: 'Incomplete' }
};

const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'date', label: 'Invoice Date' },
  { value: 'invoice_number', label: 'Invoice Number' },
  { value: 'buyer_name', label: 'Buyer Name' }
];

function StatusBadge({ status, missingFields }: { status: InvoiceStatus; missingFields?: string[] }) {
  const style = STATUS_STYLES[status];
  const hasTooltip = status === 'incomplete' && missingFields && missingFields.length > 0;

  return (
    <div className="relative group inline-block">
      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border ${style.bg} ${style.text} ${style.border}`}>
        {style.label}
      </span>
      {hasTooltip && (
        <div className="absolute z-10 invisible group-hover:visible bg-gray-900 text-white text-xs rounded-lg py-2 px-3 shadow-lg -top-2 right-full mr-2 w-max max-w-xs">
          <div className="font-semibold mb-1">Missing fields:</div>
          <ul className="list-disc list-inside space-y-0.5">
            {missingFields.map((field) => (
              <li key={field}>{field}</li>
            ))}
          </ul>
          <div className="absolute top-3 left-full w-0 h-0 border-t-4 border-t-transparent border-b-4 border-b-transparent border-l-4 border-l-gray-900" />
        </div>
      )}
    </div>
  );
}

function FilterBar({
  filters,
  sort,
  buyers,
  onFilterChange,
  onSortChange,
  onClearAll
}: {
  filters: FilterState;
  sort: SortState;
  buyers: Buyer[];
  onFilterChange: (filters: Partial<FilterState>) => void;
  onSortChange: (sort: SortState) => void;
  onClearAll: () => void;
}) {
  const [buyerSearch, setBuyerSearch] = useState('');
  const [buyerDropdownOpen, setBuyerDropdownOpen] = useState(false);

  const filteredBuyers = useMemo(() => {
    if (!buyerSearch) return buyers;
    const search = buyerSearch.toLowerCase();
    return buyers.filter(b => b.name.toLowerCase().includes(search));
  }, [buyers, buyerSearch]);

  const selectedBuyer = buyers.find(b => b.id === filters.buyerPartyId);
  const hasActiveFilters = filters.buyerPartyId !== null;

  const toggleSortDirection = () => {
    onSortChange({
      ...sort,
      direction: sort.direction === 'asc' ? 'desc' : 'asc'
    });
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg px-4 py-3 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700">Filters:</span>

          {/* Buyer Filter */}
          <div className="relative">
            <button
              onClick={() => setBuyerDropdownOpen(!buyerDropdownOpen)}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 flex items-center gap-2 min-w-[160px] justify-between"
            >
              <span className="truncate">
                {selectedBuyer ? selectedBuyer.name : 'All Buyers'}
              </span>
              <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {buyerDropdownOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setBuyerDropdownOpen(false)} />
                <div className="absolute z-20 mt-1 w-64 bg-white border border-gray-200 rounded-md shadow-lg max-h-80 overflow-hidden">
                  <div className="p-2 border-b border-gray-200">
                    <input
                      type="text"
                      placeholder="Search buyers..."
                      value={buyerSearch}
                      onChange={(e) => setBuyerSearch(e.target.value)}
                      className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                      autoFocus
                    />
                  </div>
                  <div className="max-h-60 overflow-y-auto">
                    <button
                      onClick={() => {
                        onFilterChange({ buyerPartyId: null });
                        setBuyerDropdownOpen(false);
                        setBuyerSearch('');
                      }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2"
                    >
                      <span className="font-medium">All Buyers</span>
                    </button>
                    {filteredBuyers.map((buyer) => (
                      <button
                        key={buyer.id}
                        onClick={() => {
                          onFilterChange({ buyerPartyId: buyer.id });
                          setBuyerDropdownOpen(false);
                          setBuyerSearch('');
                        }}
                        className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-50 ${
                          filters.buyerPartyId === buyer.id ? 'bg-blue-50 text-blue-700 font-medium' : ''
                        }`}
                      >
                        {buyer.name}
                      </button>
                    ))}
                    {filteredBuyers.length === 0 && (
                      <div className="px-3 py-2 text-sm text-gray-500">No buyers found</div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {hasActiveFilters && (
            <button
              onClick={onClearAll}
              className="text-sm text-gray-600 hover:text-gray-700 font-medium"
            >
              Clear all
            </button>
          )}
        </div>

        {/* Sort Controls */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-700">Sort:</span>
          <select
            value={sort.field}
            onChange={(e) => onSortChange({ ...sort, field: e.target.value as SortField })}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            onClick={toggleSortDirection}
            className="p-1.5 text-gray-600 hover:bg-gray-100 rounded transition-colors"
            title={sort.direction === 'asc' ? 'Ascending' : 'Descending'}
          >
            {sort.direction === 'asc' ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ActiveFilters({
  filters,
  buyers,
  onRemove
}: {
  filters: FilterState;
  buyers: Buyer[];
  onRemove: (key: keyof FilterState) => void;
}) {
  const activeFilters: { key: keyof FilterState; label: string; value: string }[] = [];

  if (filters.buyerPartyId) {
    const buyer = buyers.find(b => b.id === filters.buyerPartyId);
    if (buyer) {
      activeFilters.push({ key: 'buyerPartyId', label: 'Buyer', value: buyer.name });
    }
  }

  if (activeFilters.length === 0) return null;

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-gray-600 font-medium">Active:</span>
      {activeFilters.map((filter) => (
        <button
          key={filter.key}
          onClick={() => onRemove(filter.key)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-md hover:bg-blue-100 transition-colors"
        >
          <span className="font-medium">{filter.label}:</span>
          <span>{filter.value}</span>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      ))}
    </div>
  );
}

function PaginationControls({
  currentPage,
  totalPages,
  totalItems,
  itemsPerPage,
  startItem,
  endItem,
  onPageChange,
  onPerPageChange
}: {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage: number;
  startItem: number;
  endItem: number;
  onPageChange: (page: number) => void;
  onPerPageChange: (perPage: number) => void;
}) {
  // Generate page numbers with ellipsis
  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    const maxVisible = 7; // Maximum page numbers to show

    if (totalPages <= maxVisible) {
      // Show all pages if total is small
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      // Always show first page
      pages.push(1);

      if (currentPage <= 4) {
        // Near the beginning
        for (let i = 2; i <= 5; i++) {
          pages.push(i);
        }
        pages.push('ellipsis-end');
        pages.push(totalPages);
      } else if (currentPage >= totalPages - 3) {
        // Near the end
        pages.push('ellipsis-start');
        for (let i = totalPages - 4; i <= totalPages; i++) {
          pages.push(i);
        }
      } else {
        // In the middle
        pages.push('ellipsis-start');
        for (let i = currentPage - 1; i <= currentPage + 1; i++) {
          pages.push(i);
        }
        pages.push('ellipsis-end');
        pages.push(totalPages);
      }
    }

    return pages;
  };

  const pageNumbers = getPageNumbers();

  return (
    <div className="mt-6 bg-white border border-gray-200 rounded-lg px-4 py-3">
      <div className="flex items-center justify-between">
        {/* Left: Items per page + Range */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-700">Show</span>
            <select
              value={itemsPerPage}
              onChange={(e) => onPerPageChange(Number(e.target.value))}
              className="px-2 py-1 text-sm border border-gray-300 rounded-md bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
            <span className="text-sm text-gray-700">per page</span>
          </div>
          <div className="text-sm text-gray-600">
            {startItem}–{endItem} of {totalItems}
          </div>
        </div>

        {/* Right: Pagination */}
        <div className="flex items-center gap-1">
          {/* Previous button */}
          <button
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage === 1}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              currentPage === 1
                ? 'text-gray-400 cursor-not-allowed'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
            aria-label="Previous page"
          >
            Previous
          </button>

          {/* Page numbers */}
          {pageNumbers.map((page, idx) => {
            if (typeof page === 'string') {
              return (
                <span key={page + idx} className="px-2 text-gray-400">
                  ⋯
                </span>
              );
            }

            return (
              <button
                key={page}
                onClick={() => onPageChange(page)}
                className={`min-w-[36px] px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  currentPage === page
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'text-gray-700 hover:bg-gray-100'
                }`}
                aria-label={`Page ${page}`}
                aria-current={currentPage === page ? 'page' : undefined}
              >
                {page}
              </button>
            );
          })}

          {/* Next button */}
          <button
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage === totalPages}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              currentPage === totalPages
                ? 'text-gray-400 cursor-not-allowed'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
            aria-label="Next page"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

function MassActionBar({
  mode,
  selectedCount,
  pageSelectedCount,
  totalCount,
  onSelectAll,
  onClear,
  onDownload,
  onUpdateDate,
  onDelete,
  onUpdateBuyer
}: {
  mode: SelectionMode;
  selectedCount: number;
  pageSelectedCount: number;
  totalCount: number;
  onSelectAll: () => void;
  onClear: () => void;
  onDownload: () => void;
  onUpdateDate: () => void;
  onDelete: () => void;
  onUpdateBuyer: () => void;
}) {
  return (
    <div className="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-4 py-3 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="text-sm text-gray-900">
          {selectedCount === 0 ? (
            <span className="text-gray-600">Select invoices to perform bulk actions</span>
          ) : mode === 'all' && selectedCount === totalCount ? (
            <span className="font-semibold">All {totalCount} selected</span>
          ) : (
            <span className="font-semibold">{selectedCount} selected</span>
          )}
        </div>

        {selectedCount > 0 && selectedCount < totalCount && (
          <>
            <span className="text-gray-300">|</span>
            <button
              onClick={onSelectAll}
              className="text-sm text-blue-600 hover:text-blue-700 font-medium"
            >
              Select all {totalCount}
            </button>
          </>
        )}

        {selectedCount > 0 && (
          <>
            <span className="text-gray-300">|</span>
            <button
              onClick={onClear}
              className="text-sm text-gray-600 hover:text-gray-700 font-medium"
            >
              Clear
            </button>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onDownload}
          disabled={selectedCount === 0}
          className={`px-3 py-2 rounded-md text-sm font-semibold border transition-colors ${selectedCount === 0 ? 'text-gray-400 bg-gray-100 border-gray-200 cursor-not-allowed' : 'text-blue-700 bg-blue-50 border-blue-200 hover:bg-blue-100'}`}
        >
          Download XML
        </button>
        <button
          onClick={onUpdateDate}
          disabled={selectedCount === 0}
          className={`px-3 py-2 rounded-md text-sm font-semibold border transition-colors ${selectedCount === 0 ? 'text-gray-400 bg-gray-100 border-gray-200 cursor-not-allowed' : 'text-indigo-800 bg-indigo-50 border-indigo-200 hover:bg-indigo-100'}`}
        >
          Update Date
        </button>
        <button
          onClick={onUpdateBuyer}
          disabled={selectedCount === 0}
          className={`px-3 py-2 rounded-md text-sm font-semibold border transition-colors ${selectedCount === 0 ? 'text-gray-400 bg-gray-100 border-gray-200 cursor-not-allowed' : 'text-amber-800 bg-amber-50 border-amber-200 hover:bg-amber-100'}`}
        >
          Update Buyer
        </button>
        <button
          onClick={onDelete}
          disabled={selectedCount === 0}
          className={`px-3 py-2 rounded-md text-sm font-semibold border transition-colors ${selectedCount === 0 ? 'text-gray-400 bg-gray-100 border-gray-200 cursor-not-allowed' : 'text-red-700 bg-red-50 border-red-200 hover:bg-red-100'}`}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

interface Pagination {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export default function QueueV2Page() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionState>({
    mode: 'none',
    selectedIds: new Set(),
    excludedIds: new Set()
  });
  const [pagination, setPagination] = useState<Pagination>({ total: 0, limit: 50, offset: 0, hasMore: false });
  const [currentPage, setCurrentPage] = useState(1);
  const [perPage, setPerPage] = useState(50);

  // Filter & Sort State
  const [filters, setFilters] = useState<FilterState>({
    buyerPartyId: null
  });
  const [sort, setSort] = useState<SortState>({
    field: 'date',
    direction: 'desc'
  });
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [showAddBuyerModal, setShowAddBuyerModal] = useState(false);
  const [buyerNameToResolve, setBuyerNameToResolve] = useState<string | null>(null);
  const [partyFormError, setPartyFormError] = useState<string | null>(null);
  const [transactionCodes, setTransactionCodes] = useState<TransactionCode[]>([]);
  const [sellers, setSellers] = useState<SellerOption[]>([]);
  const [sellersLoading, setSellersLoading] = useState(false);
  const [banner, setBanner] = useState<BannerState | null>(null);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [partyOptions, setPartyOptions] = useState<PartyOption[]>([]);
  const [partySearch, setPartySearch] = useState('');
  const [debouncedPartySearch, setDebouncedPartySearch] = useState('');
  const [partyTypeFilter, setPartyTypeFilter] = useState<'all' | 'buyer'>('buyer');
  const [selectedPartyId, setSelectedPartyId] = useState('');
  const [partyLoading, setPartyLoading] = useState(false);
  const [linkModalError, setLinkModalError] = useState<string | null>(null);
  const [linkModalLoading, setLinkModalLoading] = useState(false);
  const [showDateModal, setShowDateModal] = useState(false);
  const [dateValue, setDateValue] = useState('');
  const [dateError, setDateError] = useState<string | null>(null);
  const [dateLoading, setDateLoading] = useState(false);
  const [dateTargetInvoiceIds, setDateTargetInvoiceIds] = useState<string[]>([]);

  // Fetch unique buyers for dropdown
  const fetchBuyers = async () => {
    try {
      const res = await fetch('/api/buyers');
      const data = await res.json();
      setBuyers(data.buyers || []);
    } catch (err) {
      console.error('Failed to fetch buyers:', err);
    }
  };

  const fetchTransactionCodes = useCallback(async () => {
    if (transactionCodes.length > 0) return;
    try {
      const response = await fetch('/api/transaction-codes');
      if (!response.ok) {
        throw new Error('Failed to load transaction codes');
      }
      const rawCodes = await response.json();
      const normalizedCodes: TransactionCode[] = (rawCodes || []).map((code: any) => ({
        code: code.code,
        name: code.name,
        description: code.description ?? ''
      }));
      setTransactionCodes(normalizedCodes);
    } catch (err) {
      console.error('Failed to load transaction codes', err);
      setPartyFormError(err instanceof Error ? err.message : 'Failed to load transaction codes');
    }
  }, [transactionCodes.length]);

  const fetchSellerOptions = useCallback(async () => {
    if (sellers.length > 0) return;
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
        .map((party: any) => ({
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
  }, [sellers.length]);

  const fetchPartyOptions = useCallback(async () => {
    try {
      setPartyLoading(true);
      const params = new URLSearchParams({
        page: '1',
        limit: '50'
      });
      if (partyTypeFilter === 'buyer') {
        params.append('type', 'buyer');
      }
      if (debouncedPartySearch && debouncedPartySearch.length >= 2) {
        params.append('search', debouncedPartySearch);
      }
      const res = await fetch(`/api/parties?${params.toString()}`);
      if (!res.ok) {
        throw new Error('Failed to fetch parties');
      }
      const data = await res.json();
      const mapped: PartyOption[] = (data.parties || []).map((p: any) => ({
        id: p.id,
        displayName: p.displayName,
        partyType: p.partyType,
        tinDisplay: p.tinDisplay
      }));
      setPartyOptions(mapped);
      if (mapped.length > 0) {
        const exists = mapped.some((p) => p.id === selectedPartyId);
        if (!exists) {
          setSelectedPartyId(mapped[0].id);
        }
      } else {
        setSelectedPartyId('');
      }
    } catch (err) {
      console.error('Failed to fetch party options', err);
      setLinkModalError(err instanceof Error ? err.message : 'Failed to load parties');
    } finally {
      setPartyLoading(false);
    }
  }, [debouncedPartySearch, partyTypeFilter, selectedPartyId]);

  // Initialize from URL params or localStorage on mount
  useEffect(() => {
    const buyerParam = searchParams.get('buyer');
    const sortParam = searchParams.get('sort') as SortField | null;
    const dirParam = searchParams.get('dir') as SortDirection | null;

    // Load from URL or localStorage
    const savedFilters = localStorage.getItem('queue-filters');
    const savedSort = localStorage.getItem('queue-sort');

    if (buyerParam || sortParam) {
      // URL takes precedence (shareable links)
      setFilters({ buyerPartyId: buyerParam });
      setSort({
        field: sortParam || 'date',
        direction: dirParam || 'desc'
      });
    } else if (savedFilters && savedSort) {
      // Fall back to localStorage
      try {
        const parsedFilters = JSON.parse(savedFilters);
        const parsedSort = JSON.parse(savedSort);
        setFilters(parsedFilters);
        setSort(parsedSort);
      } catch (e) {
        console.error('Failed to parse saved filters/sort:', e);
      }
    }

    fetchBuyers();
  }, []);

  useEffect(() => {
    if (showAddBuyerModal) {
      setPartyFormError(null);
      fetchTransactionCodes();
      fetchSellerOptions();
    }
  }, [showAddBuyerModal, fetchSellerOptions, fetchTransactionCodes]);

  useEffect(() => {
    if (showLinkModal) {
      fetchPartyOptions();
    }
  }, [showLinkModal, fetchPartyOptions]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedPartySearch(partySearch.trim()), 250);
    return () => clearTimeout(timer);
  }, [partySearch]);

  // Sync to URL and localStorage on filter/sort change
  const updateFiltersAndSort = useCallback((
    newFilters: Partial<FilterState>,
    newSort?: SortState
  ) => {
    const updatedFilters = { ...filters, ...newFilters };
    const updatedSort = newSort || sort;

    setFilters(updatedFilters);
    if (newSort) setSort(updatedSort);

    // Clear selection when filters change (data set changes)
    setSelection({
      mode: 'none',
      selectedIds: new Set(),
      excludedIds: new Set()
    });

    // Update URL
    const params = new URLSearchParams(searchParams);
    if (updatedFilters.buyerPartyId) {
      params.set('buyer', updatedFilters.buyerPartyId);
    } else {
      params.delete('buyer');
    }
    params.set('sort', updatedSort.field);
    params.set('dir', updatedSort.direction);
    params.set('page', '1'); // Reset to page 1 on filter/sort change

    router.push(`/queue-v2?${params.toString()}`, { scroll: false });

    // Save to localStorage
    localStorage.setItem('queue-filters', JSON.stringify(updatedFilters));
    localStorage.setItem('queue-sort', JSON.stringify(updatedSort));

    // Note: fetchInvoices will be triggered automatically by the useEffect that depends on filters/sort
  }, [filters, sort, perPage, searchParams, router]);

  const fetchInvoices = async (page: number = 1, itemsPerPage: number = perPage) => {
    setLoading(true);
    try {
      const offset = (page - 1) * itemsPerPage;
      const params = new URLSearchParams({
        limit: itemsPerPage.toString(),
        offset: offset.toString(),
        sort: sort.field,
        dir: sort.direction
      });

      if (filters.buyerPartyId) {
        params.set('buyer', filters.buyerPartyId);
      }

      const res = await fetch(`/api/tax-invoices?${params}`);
      if (!res.ok) {
        throw new Error('Failed to fetch invoices');
      }
      const data = await res.json();
      setInvoices(data.invoices || []);
      setPagination(data.pagination || { total: 0, limit: itemsPerPage, offset, hasMore: false });
      setCurrentPage(page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const handlePerPageChange = (newPerPage: number) => {
    setPerPage(newPerPage);
    setCurrentPage(1);
    fetchInvoices(1, newPerPage);
  };

  // Fetch invoices when filters or sort change (after initialization)
  useEffect(() => {
    fetchInvoices(1, perPage);
  }, [filters, sort]);

  // Calculate actual selection based on mode
  const getActualSelection = useMemo(() => {
    if (selection.mode === 'all') {
      // All selected except excluded ones
      return invoices.filter((inv) => !selection.excludedIds.has(inv.id));
    } else {
      // Only explicitly selected ones
      return invoices.filter((inv) => selection.selectedIds.has(inv.id));
    }
  }, [selection, invoices]);

  const selectedCount = useMemo(() => {
    if (selection.mode === 'all') {
      return pagination.total - selection.excludedIds.size;
    }
    return selection.selectedIds.size;
  }, [selection, pagination.total]);

  const isSelected = (id: string): boolean => {
    if (selection.mode === 'all') {
      return !selection.excludedIds.has(id);
    }
    return selection.selectedIds.has(id);
  };

  const toggleSelect = (id: string) => {
    setSelection((prev) => {
      if (prev.mode === 'all') {
        // In 'all' mode, toggle means add/remove from excluded
        const newExcluded = new Set(prev.excludedIds);
        if (newExcluded.has(id)) {
          newExcluded.delete(id);
        } else {
          newExcluded.add(id);
        }
        return { ...prev, excludedIds: newExcluded };
      } else {
        // In 'none' or 'page' mode, toggle in selectedIds
        const newSelected = new Set(prev.selectedIds);
        if (newSelected.has(id)) {
          newSelected.delete(id);
        } else {
          newSelected.add(id);
        }
        return { ...prev, selectedIds: newSelected };
      }
    });
  };

  const allPageSelected = useMemo(() => {
    if (invoices.length === 0) return false;
    return invoices.every((inv) => isSelected(inv.id));
  }, [invoices, selection]);

  const somePageSelected = useMemo(() => {
    if (invoices.length === 0) return false;
    return invoices.some((inv) => isSelected(inv.id)) && !allPageSelected;
  }, [invoices, selection, allPageSelected]);

  const toggleSelectAllOnPage = () => {
    if (allPageSelected) {
      // Deselect all on this page
      if (selection.mode === 'all') {
        // Add current page to excluded
        const newExcluded = new Set(selection.excludedIds);
        invoices.forEach((inv) => newExcluded.add(inv.id));
        setSelection({ ...selection, excludedIds: newExcluded });
      } else {
        // Remove current page from selected
        const newSelected = new Set(selection.selectedIds);
        invoices.forEach((inv) => newSelected.delete(inv.id));
        setSelection({ ...selection, selectedIds: newSelected, mode: newSelected.size > 0 ? 'page' : 'none' });
      }
    } else {
      // Select all on this page
      if (selection.mode === 'all') {
        // Remove current page from excluded
        const newExcluded = new Set(selection.excludedIds);
        invoices.forEach((inv) => newExcluded.delete(inv.id));
        setSelection({ ...selection, excludedIds: newExcluded });
      } else {
        const newSelected = new Set(selection.selectedIds);
        invoices.forEach((inv) => newSelected.add(inv.id));
        setSelection({ ...selection, selectedIds: newSelected, mode: 'page' });
      }
    }
  };

  const selectAllAcrossPages = () => {
    setSelection({
      mode: 'all',
      selectedIds: new Set(),
      excludedIds: new Set()
    });
  };

  const clearSelection = () => {
    setSelection({
      mode: 'none',
      selectedIds: new Set(),
      excludedIds: new Set()
    });
  };

  const handleDownload = async () => {
    if (selectedCount === 0) return;

    const confirmed = window.confirm(`Download XML for ${selectedCount} invoice${selectedCount > 1 ? 's' : ''}?`);
    if (!confirmed) return;

    try {
      // For 'all' mode, we need to fetch all invoice numbers except excluded ones
      let invoiceNumbers: string[];

      if (selection.mode === 'all') {
        // Fetch all invoice numbers from API
        const res = await fetch(`/api/tax-invoices?limit=${pagination.total}`);
        const data = await res.json();
        invoiceNumbers = data.invoices
          .filter((inv: Invoice) => !selection.excludedIds.has(inv.id))
          .map((inv: Invoice) => inv.invoiceNumber);
      } else {
        invoiceNumbers = getActualSelection.map((inv) => inv.invoiceNumber);
      }

      const res = await fetch('/api/tax-invoices/bulk-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceNumbers, pretty: true })
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error?.message || 'Failed to download XML');
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = invoiceNumbers.length === 1 ? `${invoiceNumbers[0]}.xml` : `invoices-${invoiceNumbers.length}.xml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to download');
    }
  };

  const handleDelete = async () => {
    if (selectedCount === 0) return;

    const confirmed = window.confirm(
      `Delete ${selectedCount} invoice${selectedCount > 1 ? 's' : ''}? This cannot be undone.`
    );
    if (!confirmed) return;

    try {
      // For 'all' mode, fetch all invoice numbers except excluded
      let invoiceNumbers: string[];

      if (selection.mode === 'all') {
        // Fetch in chunks to handle more than 500 records (API limit)
        const CHUNK_SIZE = 500;
        const allInvoiceNumbers: string[] = [];
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
          const res = await fetch(
            `/api/tax-invoices?limit=${CHUNK_SIZE}&offset=${offset}`
          );
          const data = await res.json();

          const chunk = data.invoices
            .filter((inv: Invoice) => !selection.excludedIds.has(inv.id))
            .map((inv: Invoice) => inv.invoiceNumber);

          allInvoiceNumbers.push(...chunk);

          // If we got fewer records than requested, we've reached the end
          hasMore = data.invoices.length === CHUNK_SIZE;
          offset += CHUNK_SIZE;
        }

        invoiceNumbers = allInvoiceNumbers;
      } else {
        invoiceNumbers = getActualSelection.map((inv) => inv.invoiceNumber);
      }

      const res = await fetch('/api/tax-invoices', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceNumbers })
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error?.message || 'Failed to delete');
      }

      clearSelection();
      fetchInvoices(currentPage);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  const handleReview = (invoiceId: string) => {
    window.open(`/review-v2/${invoiceId}`, '_blank');
  };

  const openAddBuyerModal = (buyerName: string) => {
    setBanner(null);
    setBuyerNameToResolve(buyerName);
    setShowAddBuyerModal(true);
  };

  const openLinkBuyerModal = () => {
    if (selectedCount === 0) return;
    setLinkModalError(null);
    setSelectedPartyId('');
    setShowLinkModal(true);
  };

  const closeLinkBuyerModal = () => {
    setShowLinkModal(false);
    setLinkModalError(null);
    setPartyOptions([]);
    setPartySearch('');
  };

  const openDateModalForSelection = () => {
    if (selectedCount === 0) return;
    setDateTargetInvoiceIds([]);
    setDateValue('');
    setDateError(null);
    setShowDateModal(true);
  };

  const openDateModalForSingle = (invoiceId: string, currentDate: string | null) => {
    setDateTargetInvoiceIds([invoiceId]);
    setDateValue(currentDate || '');
    setDateError(null);
    setShowDateModal(true);
  };

  const closeDateModal = () => {
    setShowDateModal(false);
    setDateError(null);
    setDateLoading(false);
    setDateTargetInvoiceIds([]);
  };

  const closeAddBuyerModal = () => {
    setShowAddBuyerModal(false);
    setBuyerNameToResolve(null);
    setPartyFormError(null);
  };

  const handleCreateBuyerAndResolve = async (partyData: PartyPayloadInput) => {
    if (!buyerNameToResolve) {
      throw new Error('No buyer name selected');
    }

    setPartyFormError(null);

    const createResponse = await fetch('/api/parties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partyData)
    });

    const createdPayload = await createResponse.json().catch(() => null);
    if (!createResponse.ok) {
      throw new Error(createdPayload?.error?.message || 'Failed to create party');
    }

    const newPartyId = createdPayload?.id;
    if (!newPartyId) {
      throw new Error('Party created but missing ID');
    }

    const resolveResponse = await fetch('/api/tax-invoices/resolve-buyer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        buyerName: buyerNameToResolve,
        partyId: newPartyId
      })
    });

    const resolvePayload = await resolveResponse.json().catch(() => null);
    if (!resolveResponse.ok) {
      throw new Error(resolvePayload?.error?.message || 'Failed to link invoices to buyer');
    }

    await fetchInvoices(currentPage, perPage);
    await fetchBuyers();
    setBanner({
      type: 'success',
      message: `Buyer created and ${typeof resolvePayload?.updated === 'number' ? resolvePayload.updated : 'all'} invoice(s) linked.`
    });
    closeAddBuyerModal();
  };

  const gatherSelectedInvoiceIds = async (): Promise<string[]> => {
    if (selectedCount === 0) return [];

    if (selection.mode === 'all') {
      const res = await fetch(`/api/tax-invoices?limit=${pagination.total}`);
      const data = await res.json();
      return (data.invoices || [])
        .filter((inv: Invoice) => !selection.excludedIds.has(inv.id))
        .map((inv: Invoice) => inv.id);
    }

    return getActualSelection.map((inv) => inv.id);
  };

  const handleLinkBuyerToInvoices = async () => {
    if (!selectedPartyId) {
      setLinkModalError('Select a company first');
      return;
    }

    try {
      setLinkModalLoading(true);
      setLinkModalError(null);
      const invoiceIds = await gatherSelectedInvoiceIds();
      if (invoiceIds.length === 0) {
        setLinkModalError('No invoices selected');
        return;
      }

      const response = await fetch('/api/tax-invoices/link-buyer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partyId: selectedPartyId, invoiceIds })
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message || 'Failed to link buyer');
      }

      const updatedCount = payload?.updated ?? invoiceIds.length;
      const partyName = payload?.partyName ?? 'selected party';
      const undoData: UndoSnapshot[] = payload?.undo || [];

      await fetchInvoices(currentPage, perPage);
      await fetchBuyers();
      setShowLinkModal(false);
      setBanner({
        type: 'success',
        message: `Linked ${updatedCount} invoice(s) to "${partyName}".`,
        onUndo: undoData.length
          ? async () => {
              try {
                const undoRes = await fetch('/api/tax-invoices/link-buyer', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'undo', previous: undoData })
                });
                const undoPayload = await undoRes.json().catch(() => null);
                if (!undoRes.ok) {
                  throw new Error(undoPayload?.error?.message || 'Failed to undo');
                }
                await fetchInvoices(currentPage, perPage);
                setBanner({
                  type: 'success',
                  message: 'Reverted buyer update.'
                });
              } catch (err) {
                setBanner({
                  type: 'error',
                  message: err instanceof Error ? err.message : 'Failed to undo buyer update'
                });
              }
            }
          : undefined
      });
    } catch (err) {
      setLinkModalError(err instanceof Error ? err.message : 'Failed to link buyer');
    } finally {
      setLinkModalLoading(false);
    }
  };

  const getDateTargetInvoiceIds = async () => {
    if (dateTargetInvoiceIds.length > 0) {
      return dateTargetInvoiceIds;
    }
    return gatherSelectedInvoiceIds();
  };

  const handleUpdateDate = async () => {
    if (!dateValue) {
      setDateError('Pick a date first');
      return;
    }

    try {
      setDateLoading(true);
      setDateError(null);
      const invoiceIds = await getDateTargetInvoiceIds();
      if (invoiceIds.length === 0) {
        setDateError('No invoices selected');
        return;
      }

      const response = await fetch('/api/tax-invoices/update-date', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceIds, invoiceDate: dateValue })
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message || 'Failed to update date');
      }

      const updatedCount = payload?.updated ?? invoiceIds.length;
      const undoData: UndoSnapshot[] = payload?.undo || [];

      await fetchInvoices(currentPage, perPage);
      setShowDateModal(false);
      setBanner({
        type: 'success',
        message: `Updated ${updatedCount} invoice date${updatedCount === 1 ? '' : 's'} to ${dateValue}.`,
        onUndo: undoData.length
          ? async () => {
              try {
                const undoRes = await fetch('/api/tax-invoices/update-date', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'undo', previous: undoData })
                });
                const undoPayload = await undoRes.json().catch(() => null);
                if (!undoRes.ok) {
                  throw new Error(undoPayload?.error?.message || 'Failed to undo date update');
                }
                await fetchInvoices(currentPage, perPage);
                setBanner({
                  type: 'success',
                  message: 'Reverted invoice date update.'
                });
              } catch (err) {
                setBanner({
                  type: 'error',
                  message: err instanceof Error ? err.message : 'Failed to undo date update'
                });
              }
            }
          : undefined
      });
    } catch (err) {
      setDateError(err instanceof Error ? err.message : 'Failed to update date');
    } finally {
      setDateLoading(false);
    }
  };

  if (loading && !showAddBuyerModal && !showLinkModal) {
    return <div className="flex justify-center p-8 text-gray-600">Loading invoices...</div>;
  }

  if (error) {
    return <div className="p-8 text-red-600">Error: {error}</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Processing Queue (V2)</h1>
            <p className="text-gray-600 text-sm mt-1">Invoices imported via XLS → SQL pipeline.</p>
          </div>
          <button
            onClick={() => window.location.href = '/'}
            className="px-4 py-2 rounded-md text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700"
          >
            Upload More
          </button>
        </div>

        {banner && (
          <div className={`mb-4 rounded-lg border px-4 py-3 ${banner.type === 'success' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <span>{banner.message}</span>
                {banner.onUndo && (
                  <button
                    type="button"
                    onClick={banner.onUndo}
                    className="text-sm font-semibold text-blue-700 hover:text-blue-800"
                  >
                    Undo
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setBanner(null)}
                  className="text-sm font-semibold text-gray-500 hover:text-gray-700"
                  aria-label="Dismiss message"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Filter & Sort Controls */}
        <div className="mb-4">
          <FilterBar
            filters={filters}
            sort={sort}
            buyers={buyers}
            onFilterChange={(newFilters) => updateFiltersAndSort(newFilters)}
            onSortChange={(newSort) => updateFiltersAndSort({}, newSort)}
            onClearAll={() => updateFiltersAndSort({ buyerPartyId: null })}
          />
        </div>

        {/* Active Filters Chips */}
        <div className="mb-4">
          <ActiveFilters
            filters={filters}
            buyers={buyers}
            onRemove={(key) => updateFiltersAndSort({ [key]: null })}
          />
        </div>

        <MassActionBar
          mode={selection.mode}
          selectedCount={selectedCount}
          pageSelectedCount={getActualSelection.length}
          totalCount={pagination.total}
          onSelectAll={selectAllAcrossPages}
          onClear={clearSelection}
          onDownload={handleDownload}
          onUpdateDate={() => openDateModalForSelection()}
          onDelete={handleDelete}
          onUpdateBuyer={openLinkBuyerModal}
        />

        <div className="mt-6 overflow-x-auto bg-white border border-gray-200 rounded-lg shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 w-12">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    ref={(input) => {
                      if (input) input.indeterminate = somePageSelected
                    }}
                    onChange={toggleSelectAllOnPage}
                    className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 focus:ring-2 cursor-pointer"
                    aria-label="Select all on this page"
                    title={allPageSelected ? "Deselect all on this page" : "Select all on this page"}
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Invoice Number</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Invoice Date</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Transaction Code</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Seller Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Buyer Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Status</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {invoices.map((inv) => {
                const rowSelected = isSelected(inv.id)
                return (
                  <tr key={inv.id} className={`transition-colors ${rowSelected ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={rowSelected}
                        onChange={() => toggleSelect(inv.id)}
                        className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 focus:ring-2 cursor-pointer"
                        aria-label={`Select invoice ${inv.invoiceNumber}`}
                      />
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-gray-900">{inv.invoiceNumber}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      <button
                        type="button"
                        onClick={() => openDateModalForSingle(inv.id, inv.invoiceDate)}
                        className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 font-medium underline decoration-dotted underline-offset-2"
                        title="Edit invoice date"
                      >
                        {inv.invoiceDate || 'Set date'}
                        <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h8M8 11h5m5-6h.01M5 7h.01M5 11h.01M5 15h.01M8 15h8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                      </button>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">{inv.trxCode || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{inv.sellerName}</td>
                    <td className="px-4 py-3 text-sm">
                      {inv.buyerName && inv.buyerPartyId ? (
                        <a
                          href={`/admin/parties?id=${inv.buyerPartyId}`}
                          className="text-blue-600 hover:text-blue-800 hover:underline font-medium"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {inv.buyerName}
                        </a>
                      ) : inv.buyerName && (!inv.buyerPartyId && (inv.missingFields || []).some((field) => field.startsWith('buyer') || field === 'buyer_party_id')) ? (
                        <div className="flex items-center gap-2">
                          <span className="text-gray-900 font-medium">{inv.buyerName}</span>
                          <button
                            type="button"
                            onClick={() => openAddBuyerModal(inv.buyerName!)}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-blue-200 bg-white text-blue-600 transition-colors hover:bg-blue-50 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            aria-label={`Create buyer party for ${inv.buyerName}`}
                          >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                              <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
                            </svg>
                          </button>
                        </div>
                      ) : (
                        <span className="text-gray-700">{inv.buyerName || '—'}</span>
                      )}
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={inv.status} missingFields={inv.missingFields} /></td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleReview(inv.id)}
                        className="px-3 py-1.5 text-xs font-semibold text-white bg-purple-600 hover:bg-purple-700 rounded-md shadow-sm transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-1"
                      >
                        Review
                      </button>
                    </td>
                  </tr>
                )
              })}
              {invoices.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-sm text-gray-500">
                    No invoices found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {pagination.total > 0 && (
          <PaginationControls
            currentPage={currentPage}
            totalPages={Math.ceil(pagination.total / pagination.limit)}
            totalItems={pagination.total}
            itemsPerPage={perPage}
            startItem={pagination.offset + 1}
            endItem={Math.min(pagination.offset + pagination.limit, pagination.total)}
            onPageChange={(page) => fetchInvoices(page, perPage)}
            onPerPageChange={handlePerPageChange}
          />
        )}
      </div>

      {showAddBuyerModal && buyerNameToResolve && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-gray-900/60 px-4 py-6"
          onClick={closeAddBuyerModal}
        >
          <div
            className="w-full max-w-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 p-4 sm:p-6">
              {partyFormError && (
                <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {partyFormError}
                </div>
              )}
              <AddPartyForm
                heading={`Add buyer for "${buyerNameToResolve}"`}
                description="Create the buyer and automatically link all invoices with this name."
                submitLabel="Create & Resolve"
                defaultValues={{ displayName: buyerNameToResolve }}
                forceBuyerType
                onCancel={closeAddBuyerModal}
                onSubmit={handleCreateBuyerAndResolve}
                onError={(msg) => setPartyFormError(msg)}
                transactionCodes={transactionCodes}
                sellers={sellers}
                sellersLoading={sellersLoading}
                className="p-0 bg-transparent"
              />
            </div>
          </div>
        </div>
      )}

      {showLinkModal && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-gray-900/60 px-4 py-6"
          onClick={closeLinkBuyerModal}
        >
          <div
            className="w-full max-w-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 p-6">
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500 font-semibold">Link Invoices</p>
                  <h3 className="text-lg font-semibold text-gray-900 mt-1">
                    Link {selectedCount} invoice{selectedCount > 1 ? 's' : ''} to an existing buyer
                  </h3>
                  <p className="text-sm text-gray-600">Choose a registered company. Search is debounced to reduce noise.</p>
                </div>
                <button
                  type="button"
                  onClick={closeLinkBuyerModal}
                  className="text-gray-500 hover:text-gray-700"
                  aria-label="Close link modal"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {linkModalError && (
                <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {linkModalError}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 mb-3">
                <span className="text-sm font-medium text-gray-700">Filter:</span>
                <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="radio"
                    name="party-filter"
                    value="buyer"
                    checked={partyTypeFilter === 'buyer'}
                    onChange={() => {
                      setLinkModalError(null);
                      setPartyTypeFilter('buyer');
                    }}
                  />
                  Buyers only
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="radio"
                    name="party-filter"
                    value="all"
                    checked={partyTypeFilter === 'all'}
                    onChange={() => {
                      setLinkModalError(null);
                      setPartyTypeFilter('all');
                    }}
                  />
                  All parties
                </label>
              </div>

              <div className="mb-4">
                <div className="relative">
                  <input
                    type="search"
                    value={partySearch}
                    onChange={(e) => {
                      setLinkModalError(null);
                      setPartySearch(e.target.value);
                    }}
                    placeholder="Search by company name or TIN..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {partyLoading && (
                    <div className="absolute inset-y-0 right-3 flex items-center">
                      <svg className="w-4 h-4 text-gray-400 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a10 10 0 00-10 10h4z"></path>
                      </svg>
                    </div>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-1">Type at least 2 characters to narrow the list.</p>
              </div>

              <div className="border border-gray-200 rounded-lg max-h-72 overflow-y-auto divide-y divide-gray-100">
                {partyOptions.map((party) => (
                  <button
                    key={party.id}
                    type="button"
                    onClick={() => setSelectedPartyId(party.id)}
                    className={`w-full px-4 py-3 text-left transition-colors ${
                      selectedPartyId === party.id ? 'bg-blue-50 border-l-4 border-blue-500' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-gray-900">{party.displayName}</p>
                        <p className="text-xs text-gray-600">TIN: {party.tinDisplay || '—'}</p>
                      </div>
                      <span className={`text-xs font-semibold px-2 py-1 rounded-full ${party.partyType === 'buyer' ? 'bg-green-100 text-green-800' : 'bg-orange-100 text-orange-800'}`}>
                        {party.partyType === 'buyer' ? 'Buyer' : 'Seller'}
                      </span>
                    </div>
                  </button>
                ))}
                {!partyLoading && partyOptions.length === 0 && (
                  <div className="px-4 py-6 text-sm text-gray-500 text-center">No companies found.</div>
                )}
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm text-gray-600">
                  Linking {selectedCount} invoice{selectedCount > 1 ? 's' : ''} to the selected company.
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={closeLinkBuyerModal}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                    disabled={linkModalLoading}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleLinkBuyerToInvoices}
                    disabled={linkModalLoading || !selectedPartyId}
                    className={`px-4 py-2 text-sm font-semibold text-white rounded-lg transition-colors ${linkModalLoading || !selectedPartyId ? 'bg-blue-300 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'}`}
                  >
                    {linkModalLoading ? 'Linking...' : 'Link invoices'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showDateModal && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-gray-900/60 px-4 py-6"
          onClick={closeDateModal}
        >
          <div
            className="w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 p-6">
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500 font-semibold">Update Invoice Date</p>
                  <h3 className="text-lg font-semibold text-gray-900 mt-1">
                    {dateTargetInvoiceIds.length > 0 ? 'Update invoice' : 'Bulk update'} date
                  </h3>
                  <p className="text-sm text-gray-600">
                    Applies to {dateTargetInvoiceIds.length > 0 ? dateTargetInvoiceIds.length : selectedCount} invoice{(dateTargetInvoiceIds.length > 0 ? dateTargetInvoiceIds.length : selectedCount) === 1 ? '' : 's'}.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeDateModal}
                  className="text-gray-500 hover:text-gray-700"
                  aria-label="Close date modal"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {dateError && (
                <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {dateError}
                </div>
              )}

              <label className="block text-sm font-medium text-gray-700 mb-2">Invoice Date</label>
              <input
                type="date"
                value={dateValue}
                onChange={(e) => setDateValue(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">Use YYYY-MM-DD. This date will replace the current value.</p>

              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeDateModal}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                  disabled={dateLoading}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleUpdateDate}
                  disabled={dateLoading || !dateValue}
                  className={`px-4 py-2 text-sm font-semibold text-white rounded-lg transition-colors ${dateLoading || !dateValue ? 'bg-blue-300 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'}`}
                >
                  {dateLoading ? 'Updating...' : 'Update date'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
