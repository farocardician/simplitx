'use client';

import { useState, useEffect } from 'react';
import type { HsCodeType } from '@prisma/client';

interface Product {
  id: string;
  description: string;
  hsCode: string | null;
  type: HsCodeType | null;
  uomCode: string | null;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
  uom?: {
    code: string;
    name: string;
  } | null;
  aliases?: Array<{
    id: string;
    aliasDescription: string;
    status: string;
  }>;
}

export default function ProductManagementPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('active');
  const [filterType, setFilterType] = useState<string>('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // Editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<Product>>({});

  // Create modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createValues, setCreateValues] = useState({
    description: '',
    hsCode: '',
    type: '' as '' | 'BARANG' | 'JASA',
    uomCode: '',
  });

  // Toast notifications
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Undo delete state
  const [deletedProduct, setDeletedProduct] = useState<{ id: string; product: Product } | null>(null);

  // Threshold settings
  const [threshold, setThreshold] = useState(80); // Store as percentage
  const [thresholdLoading, setThresholdLoading] = useState(false);
  const [showThresholdSettings, setShowThresholdSettings] = useState(false);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
      setPage(1); // Reset to first page on search
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Load threshold settings
  useEffect(() => {
    loadThresholdSettings();
  }, []);

  // Fetch products
  useEffect(() => {
    fetchProducts();
  }, [debouncedQuery, filterStatus, filterType, page]);

  // Auto-dismiss toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Auto-dismiss undo after 10 seconds
  useEffect(() => {
    if (deletedProduct) {
      const timer = setTimeout(() => {
        setDeletedProduct(null);
      }, 10000);
      return () => clearTimeout(timer);
    }
  }, [deletedProduct]);

  const fetchProducts = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();

      if (debouncedQuery) params.append('search', debouncedQuery);
      if (filterStatus) params.append('status', filterStatus);
      if (filterType) params.append('type', filterType);
      params.append('page', page.toString());
      params.append('pageSize', '20');
      params.append('sortBy', 'createdAt');
      params.append('sortOrder', 'desc');

      const response = await fetch(`/api/products?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch products');

      const data = await response.json();
      setProducts(data.products);
      setTotalPages(data.totalPages);
      setTotal(data.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
  };

  const loadThresholdSettings = async () => {
    try {
      const response = await fetch('/api/products/settings');
      if (response.ok) {
        const settings = await response.json();
        setThreshold(Math.round(settings.threshold * 100)); // Convert to percentage
      }
    } catch (error) {
      console.error('Failed to load threshold settings:', error);
    }
  };

  const saveThresholdSettings = async () => {
    try {
      setThresholdLoading(true);
      const response = await fetch('/api/products/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threshold: threshold / 100, // Convert from percentage
          updatedBy: 'admin',
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save settings');
      }

      showToast('Auto-fill threshold updated successfully');
      setShowThresholdSettings(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to save settings', 'error');
    } finally {
      setThresholdLoading(false);
    }
  };

  const handleCreate = async () => {
    try {
      if (!createValues.description.trim()) {
        showToast('Description is required', 'error');
        return;
      }

      const response = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: createValues.description,
          hsCode: createValues.hsCode || null,
          type: createValues.type || null,
          uomCode: createValues.uomCode || null,
          createdBy: 'admin',
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Failed to create product');
      }

      await fetchProducts();
      setShowCreateModal(false);
      setCreateValues({ description: '', hsCode: '', type: '', uomCode: '' });
      showToast('Product created successfully');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create product', 'error');
    }
  };

  const startEdit = (product: Product) => {
    setEditingId(product.id);
    setEditValues({
      description: product.description,
      hsCode: product.hsCode || '',
      type: product.type || undefined,
      uomCode: product.uomCode || '',
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValues({});
  };

  const saveEdit = async (id: string) => {
    try {
      const response = await fetch(`/api/products/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: editValues.description,
          hsCode: editValues.hsCode || null,
          type: editValues.type || null,
          uomCode: editValues.uomCode || null,
          updatedBy: 'admin',
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Failed to update product');
      }

      await fetchProducts();
      setEditingId(null);
      setEditValues({});
      showToast('Product updated successfully');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update product', 'error');
    }
  };

  const handleDelete = async (product: Product) => {
    try {
      const response = await fetch(`/api/products/${product.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Failed to delete product');
      }

      // Save deleted product for undo
      setDeletedProduct({ id: product.id, product });

      // Remove from UI
      setProducts(prev => prev.filter(p => p.id !== product.id));
      showToast(`Deleted "${product.description}"`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete product', 'error');
    }
  };

  const handleUndo = async () => {
    if (!deletedProduct) return;

    try {
      const response = await fetch(`/api/products/${deletedProduct.id}/restore`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to restore product');
      }

      await fetchProducts();
      setDeletedProduct(null);
      showToast('Product restored');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to restore product', 'error');
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Product Management</h1>
        <p className="text-gray-600">Manage active product catalog and auto-fill settings</p>
      </div>

      {/* Auto-Fill Threshold Settings */}
      <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <div>
              <h3 className="font-semibold text-gray-900">Auto-Fill Threshold</h3>
              <p className="text-sm text-gray-600">
                Current: <span className="font-mono font-bold text-blue-600">{threshold}%</span>
                {' '}- Items with match confidence ≥ {threshold}% will be auto-filled
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowThresholdSettings(!showThresholdSettings)}
            className="px-4 py-2 text-sm font-medium text-blue-700 bg-white border border-blue-300 rounded-lg hover:bg-blue-50 transition-colors"
          >
            {showThresholdSettings ? 'Hide' : 'Adjust'}
          </button>
        </div>

        {showThresholdSettings && (
          <div className="mt-4 pt-4 border-t border-blue-200">
            <div className="max-w-2xl">
              <div className="flex items-center gap-4 mb-4">
                <div className="flex-1">
                  <input
                    type="range"
                    min="50"
                    max="100"
                    step="5"
                    value={threshold}
                    onChange={(e) => setThreshold(parseInt(e.target.value))}
                    className="w-full h-2 bg-blue-200 rounded-lg appearance-none cursor-pointer slider"
                  />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>50% (Loose)</span>
                    <span>75% (Balanced)</span>
                    <span>100% (Exact)</span>
                  </div>
                </div>
                <input
                  type="number"
                  min="50"
                  max="100"
                  step="5"
                  value={threshold}
                  onChange={(e) => setThreshold(Math.min(100, Math.max(50, parseInt(e.target.value) || 50)))}
                  className="w-20 px-3 py-2 border border-gray-300 rounded-lg text-center font-mono font-bold"
                />
                <span className="text-gray-600">%</span>
              </div>

              <div className="bg-white rounded-lg p-4 mb-4 border border-gray-200">
                <h4 className="font-medium text-gray-900 mb-2 text-sm">What this means:</h4>
                <ul className="text-sm text-gray-600 space-y-1">
                  <li className="flex items-start gap-2">
                    <span className="text-green-500 mt-0.5">✓</span>
                    <span><strong>Higher threshold ({'>'}90%):</strong> Only exact or near-exact matches auto-fill. More accurate, fewer auto-fills.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-yellow-500 mt-0.5">⚠</span>
                    <span><strong>Medium threshold (70-90%):</strong> Balanced approach. Good matches auto-fill.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-red-500 mt-0.5">!</span>
                    <span><strong>Lower threshold ({'<'}70%):</strong> More auto-fills, but risk of incorrect matches.</span>
                  </li>
                </ul>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={saveThresholdSettings}
                  disabled={thresholdLoading}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  {thresholdLoading ? 'Saving...' : 'Save Changes'}
                </button>
                <button
                  onClick={() => {
                    loadThresholdSettings();
                    setShowThresholdSettings(false);
                  }}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors font-medium"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div className="mb-6 flex flex-col sm:flex-row gap-4">
        <div className="flex-1">
          <input
            type="text"
            placeholder="Search products..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <select
          value={filterStatus}
          onChange={(e) => {
            setFilterStatus(e.target.value);
            setPage(1);
          }}
          className="px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>

        <select
          value={filterType}
          onChange={(e) => {
            setFilterType(e.target.value);
            setPage(1);
          }}
          className="px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Types</option>
          <option value="BARANG">BARANG</option>
          <option value="JASA">JASA</option>
        </select>

        <button
          onClick={() => setShowCreateModal(true)}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          + New Product
        </button>
      </div>

      {/* Stats */}
      <div className="mb-4 text-sm text-gray-600">
        Showing {products.length} of {total} products
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <p className="mt-2 text-gray-600">Loading products...</p>
        </div>
      ) : (
        <>
          {/* Table */}
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Description
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      HS Code
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Type
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      UOM
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Aliases
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {products.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                        No products found
                      </td>
                    </tr>
                  ) : (
                    products.map((product) => (
                      <tr key={product.id} className="hover:bg-gray-50">
                        {editingId === product.id ? (
                          // Edit mode
                          <>
                            <td className="px-6 py-4">
                              <input
                                type="text"
                                value={editValues.description || ''}
                                onChange={(e) => setEditValues({ ...editValues, description: e.target.value })}
                                className="w-full px-2 py-1 border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            </td>
                            <td className="px-6 py-4">
                              <input
                                type="text"
                                value={editValues.hsCode || ''}
                                onChange={(e) => setEditValues({ ...editValues, hsCode: e.target.value })}
                                placeholder="6 digits"
                                maxLength={6}
                                className="w-24 px-2 py-1 border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            </td>
                            <td className="px-6 py-4">
                              <select
                                value={editValues.type || ''}
                                onChange={(e) => setEditValues({ ...editValues, type: e.target.value as any })}
                                className="px-2 py-1 border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                              >
                                <option value="">-</option>
                                <option value="BARANG">BARANG</option>
                                <option value="JASA">JASA</option>
                              </select>
                            </td>
                            <td className="px-6 py-4">
                              <input
                                type="text"
                                value={editValues.uomCode || ''}
                                onChange={(e) => setEditValues({ ...editValues, uomCode: e.target.value.toUpperCase() })}
                                placeholder="UOM"
                                className="w-24 px-2 py-1 border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            </td>
                            <td className="px-6 py-4">
                              <span className={`px-2 py-1 text-xs rounded ${
                                product.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                              }`}>
                                {product.status}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-500">
                              {product.aliases?.length || 0}
                            </td>
                            <td className="px-6 py-4 text-right space-x-2">
                              <button
                                onClick={() => saveEdit(product.id)}
                                className="text-green-600 hover:text-green-800 font-medium"
                              >
                                Save
                              </button>
                              <button
                                onClick={cancelEdit}
                                className="text-gray-600 hover:text-gray-800"
                              >
                                Cancel
                              </button>
                            </td>
                          </>
                        ) : (
                          // View mode
                          <>
                            <td className="px-6 py-4">
                              <div className="text-sm font-medium text-gray-900">{product.description}</div>
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-500">
                              {product.hsCode || '-'}
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-500">
                              {product.type || '-'}
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-500">
                              {product.uom ? `${product.uom.code} (${product.uom.name})` : '-'}
                            </td>
                            <td className="px-6 py-4">
                              <span className={`px-2 py-1 text-xs rounded ${
                                product.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                              }`}>
                                {product.status}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-500">
                              {product.aliases?.length || 0}
                            </td>
                            <td className="px-6 py-4 text-right space-x-2">
                              <button
                                onClick={() => startEdit(product)}
                                className="text-blue-600 hover:text-blue-800 font-medium"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => handleDelete(product)}
                                className="text-red-600 hover:text-red-800 font-medium"
                              >
                                Delete
                              </button>
                            </td>
                          </>
                        )}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-4 py-2 border rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                Previous
              </button>
              <span className="text-sm text-gray-600">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-4 py-2 border rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-xl font-bold mb-4">Create New Product</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description *
                </label>
                <input
                  type="text"
                  value={createValues.description}
                  onChange={(e) => setCreateValues({ ...createValues, description: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Product description"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  HS Code
                </label>
                <input
                  type="text"
                  value={createValues.hsCode}
                  onChange={(e) => setCreateValues({ ...createValues, hsCode: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="6 digits"
                  maxLength={6}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Type
                </label>
                <select
                  value={createValues.type}
                  onChange={(e) => setCreateValues({ ...createValues, type: e.target.value as any })}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select type</option>
                  <option value="BARANG">BARANG</option>
                  <option value="JASA">JASA</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  UOM Code
                </label>
                <input
                  type="text"
                  value={createValues.uomCode}
                  onChange={(e) => setCreateValues({ ...createValues, uomCode: e.target.value.toUpperCase() })}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g., UNIT, PCS, JAM"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end space-x-3">
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setCreateValues({ description: '', hsCode: '', type: '', uomCode: '' });
                }}
                className="px-4 py-2 border rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-4 right-4 px-6 py-3 rounded-lg shadow-lg ${
          toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {toast.message}
        </div>
      )}

      {/* Undo Delete Toast */}
      {deletedProduct && (
        <div className="fixed bottom-4 right-4 px-6 py-3 rounded-lg shadow-lg bg-gray-800 text-white flex items-center gap-4">
          <span>Deleted "{deletedProduct.product.description}"</span>
          <button
            onClick={handleUndo}
            className="underline font-medium hover:no-underline"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
