'use client';

import { useEffect, useState, useMemo } from 'react';

type InvoiceStatus = 'complete' | 'processing' | 'error';
type SelectionMode = 'none' | 'page' | 'all';

interface Invoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  trxCode: string | null;
  sellerName: string;
  buyerName: string | null;
  status: InvoiceStatus;
}

interface SelectionState {
  mode: SelectionMode;
  selectedIds: Set<string>;  // Used when mode is 'none' or 'page'
  excludedIds: Set<string>;  // Used when mode is 'all' - these are deselected
}

const STATUS_STYLES: Record<InvoiceStatus, { bg: string; text: string; border: string; label: string }> = {
  complete: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', label: 'Complete' },
  processing: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', label: 'Processing' },
  error: { bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-200', label: 'Error' }
};

function StatusBadge({ status }: { status: InvoiceStatus }) {
  const style = STATUS_STYLES[status];
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border ${style.bg} ${style.text} ${style.border}`}>
      {style.label}
    </span>
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
  onDelete
}: {
  mode: SelectionMode;
  selectedCount: number;
  pageSelectedCount: number;
  totalCount: number;
  onSelectAll: () => void;
  onClear: () => void;
  onDownload: () => void;
  onDelete: () => void;
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

  const fetchInvoices = async (page: number = 1, itemsPerPage: number = perPage) => {
    setLoading(true);
    try {
      const offset = (page - 1) * itemsPerPage;
      const res = await fetch(`/api/tax-invoices?limit=${itemsPerPage}&offset=${offset}`);
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

  useEffect(() => {
    fetchInvoices(1, perPage);
  }, []);

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
        const res = await fetch(`/api/tax-invoices?limit=${pagination.total}`);
        const data = await res.json();
        invoiceNumbers = data.invoices
          .filter((inv: Invoice) => !selection.excludedIds.has(inv.id))
          .map((inv: Invoice) => inv.invoiceNumber);
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
    window.open(`/review/${invoiceId}`, '_blank');
  };

  if (loading) {
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

        <MassActionBar
          mode={selection.mode}
          selectedCount={selectedCount}
          pageSelectedCount={getActualSelection.length}
          totalCount={pagination.total}
          onSelectAll={selectAllAcrossPages}
          onClear={clearSelection}
          onDownload={handleDownload}
          onDelete={handleDelete}
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
                    <td className="px-4 py-3 text-sm text-gray-700">{inv.invoiceDate || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{inv.trxCode || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{inv.sellerName}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{inv.buyerName || '—'}</td>
                    <td className="px-4 py-3"><StatusBadge status={inv.status} /></td>
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
    </div>
  );
}
