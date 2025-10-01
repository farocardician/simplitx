'use client';

import { useState, useEffect, useRef } from 'react';

interface UomAlias {
  alias: string;
  uomCode: string;
  isPrimary: boolean;
  createdAt: string;
}

interface UOM {
  code: string;
  name: string;
  aliases: UomAlias[];
}

export default function UomManagementPage() {
  const [uoms, setUoms] = useState<UOM[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [expandedUomCode, setExpandedUomCode] = useState<string | null>(null);
  const [editingAlias, setEditingAlias] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [addingAliasForUom, setAddingAliasForUom] = useState<string | null>(null);
  const [newAliasValue, setNewAliasValue] = useState('');
  const [showAddUomForm, setShowAddUomForm] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    alias: string;
    usageCount: number;
    onConfirm: () => void;
  } | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch UOMs
  useEffect(() => {
    fetchUoms();
  }, [debouncedQuery]);

  const fetchUoms = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (debouncedQuery.length >= 2) {
        params.append('search', debouncedQuery);
      }
      params.append('limit', '100');

      const response = await fetch(`/api/uom?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch UOMs');

      const data = await response.json();
      setUoms(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleAddAlias = async (uomCode: string, alias: string) => {
    try {
      const response = await fetch(`/api/uom/${uomCode}/alias`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Failed to add alias');
      }

      await fetchUoms();
      setNewAliasValue('');
      setAddingAliasForUom(null);
      showToast(`Alias "${alias.toUpperCase()}" added successfully`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to add alias', 'error');
    }
  };

  const handleDeleteAlias = async (alias: string) => {
    try {
      // Check usage stats
      const statsResponse = await fetch(`/api/uom/alias/${encodeURIComponent(alias)}`);
      if (statsResponse.ok) {
        const stats = await statsResponse.json();

        // If usage count >= 10, show confirmation
        if (stats.usageCount >= 10) {
          setDeleteConfirmation({
            alias,
            usageCount: stats.usageCount,
            onConfirm: () => performDelete(alias)
          });
          return;
        }
      }

      // Low usage: delete immediately with undo option
      performDeleteWithUndo(alias);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete alias', 'error');
    }
  };

  const performDeleteWithUndo = async (alias: string) => {
    // Optimistically remove from UI
    const previousUoms = [...uoms];
    setUoms(prev => prev.map(uom => ({
      ...uom,
      aliases: uom.aliases.filter(a => a.alias !== alias)
    })));

    // Show undo toast
    let undone = false;
    const undoToast = () => {
      if (!undone) {
        undone = true;
        setUoms(previousUoms);
        setToast(null);
      }
    };

    setToast({
      message: (
        <div className="flex items-center gap-3">
          <span>Deleted "{alias}"</span>
          <button
            onClick={undoToast}
            className="underline font-medium hover:no-underline"
          >
            Undo
          </button>
        </div>
      ) as any,
      type: 'success'
    });

    // Actually delete after 5 seconds if not undone
    setTimeout(async () => {
      if (!undone) {
        await performDelete(alias);
      }
    }, 5000);
  };

  const performDelete = async (alias: string) => {
    try {
      const response = await fetch(`/api/uom/alias/${encodeURIComponent(alias)}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Failed to delete alias');
      }

      await fetchUoms();
      setDeleteConfirmation(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete alias', 'error');
      await fetchUoms(); // Refresh to restore state
    }
  };

  const totalAliases = uoms.reduce((sum, uom) => sum + uom.aliases.length, 0);
  const primaryAliases = uoms.reduce((sum, uom) => sum + uom.aliases.filter(a => a.isPrimary).length, 0);
  const secondaryAliases = totalAliases - primaryAliases;

  if (loading && uoms.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">Loading UOMs...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 bg-white border-b shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-2xl font-bold text-gray-900">Unit of Measure Management</h1>
            <button
              onClick={() => setShowAddUomForm(!showAddUomForm)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium text-sm"
            >
              + Add UOM
            </button>
          </div>

          <div className="flex items-center gap-6">
            {/* Search */}
            <div className="flex-1 max-w-md">
              <label htmlFor="uom-search" className="sr-only">
                Search UOMs and aliases
              </label>
              <input
                id="uom-search"
                type="search"
                placeholder="Search UOMs and aliases..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                aria-describedby="search-help"
              />
              <span id="search-help" className="sr-only">
                Filter UOMs by code, name, or alias
              </span>
            </div>

            {/* Stats */}
            <div className="flex items-center gap-4 text-sm text-gray-600">
              <span className="font-medium">{uoms.length} UOMs</span>
              <span>•</span>
              <span>{totalAliases} Aliases ({secondaryAliases} custom)</span>
            </div>
          </div>

          {/* Keyboard shortcuts hint */}
          <div className="mt-2 text-xs text-gray-500">
            <kbd className="px-1.5 py-0.5 bg-gray-100 rounded">Tab</kbd> to navigate •{' '}
            <kbd className="px-1.5 py-0.5 bg-gray-100 rounded">Enter</kbd> to edit •{' '}
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

        {/* Add UOM Form */}
        {showAddUomForm && (
          <AddUomForm
            onClose={() => setShowAddUomForm(false)}
            onSuccess={() => {
              fetchUoms();
              setShowAddUomForm(false);
              showToast('UOM created successfully');
            }}
            onError={(msg) => showToast(msg, 'error')}
          />
        )}

        {/* UOM Table */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="w-8 px-3 py-3"></th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Code
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Aliases (click to manage)
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-100">
              {uoms.map((uom) => (
                <UomRow
                  key={uom.code}
                  uom={uom}
                  isExpanded={expandedUomCode === uom.code}
                  onToggleExpand={() => setExpandedUomCode(expandedUomCode === uom.code ? null : uom.code)}
                  addingAlias={addingAliasForUom === uom.code}
                  newAliasValue={newAliasValue}
                  onNewAliasChange={setNewAliasValue}
                  onStartAddAlias={() => setAddingAliasForUom(uom.code)}
                  onAddAlias={(alias) => handleAddAlias(uom.code, alias)}
                  onCancelAddAlias={() => {
                    setAddingAliasForUom(null);
                    setNewAliasValue('');
                  }}
                  onDeleteAlias={handleDeleteAlias}
                />
              ))}
            </tbody>
          </table>

          {uoms.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              {searchQuery ? 'No UOMs found matching your search' : 'No UOMs available'}
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
            } text-white`}
          >
            {typeof toast.message === 'string' ? toast.message : toast.message}
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {deleteConfirmation && (
        <DeleteConfirmationDialog
          alias={deleteConfirmation.alias}
          usageCount={deleteConfirmation.usageCount}
          onConfirm={deleteConfirmation.onConfirm}
          onCancel={() => setDeleteConfirmation(null)}
        />
      )}
    </div>
  );
}

// UomRow Component
function UomRow({
  uom,
  isExpanded,
  onToggleExpand,
  addingAlias,
  newAliasValue,
  onNewAliasChange,
  onStartAddAlias,
  onAddAlias,
  onCancelAddAlias,
  onDeleteAlias
}: {
  uom: UOM;
  isExpanded: boolean;
  onToggleExpand: () => void;
  addingAlias: boolean;
  newAliasValue: string;
  onNewAliasChange: (value: string) => void;
  onStartAddAlias: () => void;
  onAddAlias: (alias: string) => void;
  onCancelAddAlias: () => void;
  onDeleteAlias: (alias: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addingAlias && inputRef.current) {
      inputRef.current.focus();
    }
  }, [addingAlias]);

  const secondaryAliases = uom.aliases.filter(a => !a.isPrimary);

  return (
    <tr className="hover:bg-gray-50">
      <td className="px-3 py-4">
        <button
          onClick={onToggleExpand}
          className="text-gray-400 hover:text-gray-600"
          aria-label={isExpanded ? 'Collapse aliases' : 'Expand aliases'}
        >
          {isExpanded ? '▼' : '▶'}
        </button>
      </td>
      <td className="px-4 py-4">
        <code className="text-sm font-semibold text-gray-900">{uom.code}</code>
      </td>
      <td className="px-4 py-4">
        <span className="text-sm text-gray-700">{uom.name}</span>
      </td>
      <td className="px-4 py-4">
        <div className="flex flex-wrap gap-2 items-center">
          {secondaryAliases.map((alias) => (
            <AliasPill
              key={alias.alias}
              alias={alias.alias}
              isPrimary={alias.isPrimary}
              onDelete={() => onDeleteAlias(alias.alias)}
            />
          ))}

          {addingAlias ? (
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={newAliasValue}
                onChange={(e) => onNewAliasChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newAliasValue.trim()) {
                    onAddAlias(newAliasValue);
                  } else if (e.key === 'Escape') {
                    onCancelAddAlias();
                  }
                }}
                placeholder="New alias..."
                className="px-3 py-1 text-xs border border-blue-300 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={() => newAliasValue.trim() && onAddAlias(newAliasValue)}
                className="text-green-600 hover:text-green-700 font-bold"
                aria-label="Save alias"
              >
                ✓
              </button>
              <button
                onClick={onCancelAddAlias}
                className="text-red-600 hover:text-red-700 font-bold"
                aria-label="Cancel"
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              onClick={onStartAddAlias}
              className="px-3 py-1 text-xs font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-full transition-colors"
              aria-label={`Add alias to ${uom.name}`}
            >
              + Add
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// AliasPill Component
function AliasPill({
  alias,
  isPrimary,
  onDelete
}: {
  alias: string;
  isPrimary: boolean;
  onDelete: () => void;
}) {
  const [showDelete, setShowDelete] = useState(false);

  return (
    <div
      className="relative inline-block"
      onMouseEnter={() => !isPrimary && setShowDelete(true)}
      onMouseLeave={() => setShowDelete(false)}
    >
      <span
        className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium ${
          isPrimary
            ? 'bg-green-100 text-green-800'
            : 'bg-gray-100 text-gray-700'
        }`}
      >
        {alias}
        {!isPrimary && showDelete && (
          <button
            onClick={onDelete}
            className="ml-1 text-red-600 hover:text-red-700 font-bold"
            aria-label={`Delete alias ${alias}`}
          >
            ×
          </button>
        )}
      </span>
    </div>
  );
}

// AddUomForm Component
function AddUomForm({
  onClose,
  onSuccess,
  onError
}: {
  onClose: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!code.trim() || !name.trim()) {
      onError('Code and name are required');
      return;
    }

    try {
      setSubmitting(true);
      const aliasArray = aliases
        .split(',')
        .map(a => a.trim())
        .filter(Boolean);

      const response = await fetch('/api/uom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name, aliases: aliasArray })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Failed to create UOM');
      }

      onSuccess();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to create UOM');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mb-6 p-6 bg-blue-50 border border-blue-200 rounded-lg">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Add New UOM</h3>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="uom-code" className="block text-sm font-medium text-gray-700 mb-1">
              Code <span className="text-red-500">*</span>
            </label>
            <input
              id="uom-code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="UM.0099"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
          <div>
            <label htmlFor="uom-name" className="block text-sm font-medium text-gray-700 mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              id="uom-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Custom Unit"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
        </div>
        <div>
          <label htmlFor="uom-aliases" className="block text-sm font-medium text-gray-700 mb-1">
            Aliases (comma-separated)
          </label>
          <input
            id="uom-aliases"
            type="text"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="CU, CUST, CUSTOM"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
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
            {submitting ? 'Creating...' : 'Create UOM + Aliases'}
          </button>
        </div>
      </form>
    </div>
  );
}

// DeleteConfirmationDialog Component
function DeleteConfirmationDialog({
  alias,
  usageCount,
  onConfirm,
  onCancel
}: {
  alias: string;
  usageCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md shadow-xl">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 text-red-600">
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Delete high-usage alias?</h3>
            <p className="mt-2 text-sm text-gray-600">
              The alias <strong>"{alias}"</strong> has been used <strong>{usageCount} times</strong> in
              documents.
            </p>
            <p className="mt-2 text-sm text-gray-600">
              Future documents containing "{alias}" will not be recognized until you add it again.
            </p>
          </div>
        </div>

        <div className="mt-6 flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onConfirm();
              onCancel();
            }}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded hover:bg-red-700"
          >
            Delete Anyway
          </button>
        </div>
      </div>
    </div>
  );
}
