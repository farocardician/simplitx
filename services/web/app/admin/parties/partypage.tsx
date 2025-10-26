'use client';

import { useState, useEffect, useRef } from 'react';

interface Party {
  id: string;
  displayName: string;
  tinDisplay: string;
  countryCode: string | null;
  addressFull: string | null;
  email: string | null;
  buyerDocument: string | null;
  buyerDocumentNumber: string | null;
  buyerIdtku: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PaginationInfo {
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
  hasMore: boolean;
}

const CLIENT_SIDE_THRESHOLD = 200;

export default function PartiesManagementPage() {
  const [parties, setParties] = useState<Party[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [countryFilter, setCountryFilter] = useState<string>('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingCell, setEditingCell] = useState<{ partyId: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [toast, setToast] = useState<{ message: any; type: 'success' | 'error'; undo?: () => void } | null>(null);
  const [pagination, setPagination] = useState<PaginationInfo>({
    page: 1,
    limit: 50,
    totalCount: 0,
    totalPages: 0,
    hasMore: false
  });

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
  }, [debouncedQuery, countryFilter, pagination.page]);

  const fetchParties = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();

      if (debouncedQuery.length >= 2) {
        params.append('search', debouncedQuery);
      }

      if (countryFilter) {
        params.append('country_code', countryFilter);
      }

      params.append('page', String(pagination.page));
      params.append('limit', String(pagination.limit));

      const response = await fetch(`/api/parties?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch parties');

      const data = await response.json();
      setParties(data.parties);
      setPagination(data.pagination);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const showToast = (message: any, type: 'success' | 'error' = 'success', undo?: () => void) => {
    setToast({ message, type, undo });
    if (!undo) {
      setTimeout(() => setToast(null), 3000);
    }
  };

  const handleAddParty = async (partyData: Omit<Party, 'id' | 'createdAt' | 'updatedAt'>) => {
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
          } catch (err) {
            showToast('Failed to restore party', 'error');
            await fetchParties();
          }
        }
      };

      setToast({
        message: (
          <div className="flex items-center gap-3">
            <span>Deleted "{party.displayName}"</span>
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

  const saveEdit = (party: Party) => {
    if (editingCell) {
      handleUpdateParty(party.id, editingCell.field, editValue, party);
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
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 bg-white border-b shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-2xl font-bold text-gray-900">Company Directory</h1>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium text-sm"
              aria-label="Add new company"
            >
              + Add Party
            </button>
          </div>

          <div className="flex items-center gap-4">
            {/* Search */}
            <div className="flex-1 max-w-md">
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

            {/* Country Filter */}
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

            {/* Stats */}
            <div className="flex items-center gap-4 text-sm text-gray-600">
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

        {/* Add Party Form */}
        {showAddForm && (
          <AddPartyForm
            onClose={() => setShowAddForm(false)}
            onSuccess={handleAddParty}
            onError={(msg) => showToast(msg, 'error')}
          />
        )}

        {/* Parties Table */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200" aria-label="Company directory">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Company Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    TIN
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Country
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
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
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
                    onDelete={handleDeleteParty}
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
            {typeof toast.message === 'string' ? toast.message : toast.message}
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
  onDelete
}: {
  party: Party;
  editingCell: { partyId: string; field: string } | null;
  editValue: string;
  onStartEdit: (partyId: string, field: string, currentValue: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (party: Party) => void;
  onEditValueChange: (value: string) => void;
  onDelete: (party: Party) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingCell && editingCell.partyId === party.id && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingCell, party.id]);

  const isEditing = (field: string) =>
    editingCell?.partyId === party.id && editingCell?.field === field;

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
    <tr className="hover:bg-gray-50">
      <td className="px-4 py-3">
        <span className="font-medium text-gray-900">
          {renderCell('displayName', party.displayName)}
        </span>
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
        <span className="text-sm text-gray-700">
          {renderCell('addressFull', party.addressFull)}
        </span>
      </td>
      <td className="px-4 py-3">
        <button
          onClick={() => onDelete(party)}
          className="px-3 py-1 text-xs font-medium text-red-600 hover:text-red-700 hover:bg-red-50 rounded transition-colors"
          aria-label={`Delete ${party.displayName}`}
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

// AddPartyForm Component
function AddPartyForm({
  onClose,
  onSuccess,
  onError
}: {
  onClose: () => void;
  onSuccess: (data: Omit<Party, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onError: (message: string) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [tinDisplay, setTinDisplay] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [email, setEmail] = useState('');
  const [addressFull, setAddressFull] = useState('');
  const [buyerDocument, setBuyerDocument] = useState('TIN');
  const [buyerDocumentNumber, setBuyerDocumentNumber] = useState('');
  const [buyerIdtku, setBuyerIdtku] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const displayNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    displayNameRef.current?.focus();
  }, []);

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
        email: email.trim() || null,
        addressFull: addressFull.trim() || null,
        buyerDocument: buyerDocument.trim() || null,
        buyerDocumentNumber: buyerDocumentNumber.trim() || null,
        buyerIdtku: buyerIdtku.trim() || null
      });

      // Reset form
      setDisplayName('');
      setTinDisplay('');
      setCountryCode('');
      setEmail('');
      setAddressFull('');
      setBuyerDocument('TIN');
      setBuyerDocumentNumber('');
      setBuyerIdtku('');
    } catch (err) {
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
            <p className="text-xs text-gray-500 mt-1">Defaults to "TIN", can be edited or cleared</p>
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
