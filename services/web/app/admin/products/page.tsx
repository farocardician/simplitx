'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { HsCodeType } from '@prisma/client';
import {
  fetchHsCodeSuggestions,
  formatHsTypeLabel,
  type HsCodeSuggestion
} from '@/lib/hsCodes';
import { DEFAULT_JASA_UOM_CODE, formatUomLabel, normalizeUomPayload, type UomOption } from '@/lib/uom';

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
  const [createHsSuggestions, setCreateHsSuggestions] = useState<HsCodeSuggestion[]>([]);
  const [createHsLoading, setCreateHsLoading] = useState(false);
  const [createHsDropdownOpen, setCreateHsDropdownOpen] = useState(false);
  const [createHsSelectedIndex, setCreateHsSelectedIndex] = useState(-1);
  const [createHsLastQuery, setCreateHsLastQuery] = useState('');
  const [createHsError, setCreateHsError] = useState<string | null>(null);
  const createHsSearchTimer = useRef<NodeJS.Timeout | null>(null);
  const createHsInputRef = useRef<HTMLInputElement | null>(null);
  const createHsDropdownRef = useRef<HTMLDivElement | null>(null);
  const [createHsSelectedData, setCreateHsSelectedData] = useState<HsCodeSuggestion | null>(null);
  const [createHsTooltipVisible, setCreateHsTooltipVisible] = useState(false);
  const [createHsTooltipLang, setCreateHsTooltipLang] = useState<'id' | 'en'>('id');
  const createHsTooltipHideTimer = useRef<NodeJS.Timeout | null>(null);
  const createHsLatestRequestRef = useRef<{ token: symbol } | null>(null);
  const [uomList, setUomList] = useState<UomOption[]>([]);
  const [uomLoading, setUomLoading] = useState(false);
  const [uomError, setUomError] = useState<string | null>(null);

  // Toast notifications
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Undo delete state
  const [deletedProduct, setDeletedProduct] = useState<{ id: string; product: Product } | null>(null);

  // Threshold settings
  const [threshold, setThreshold] = useState(80); // Store as percentage
  const [thresholdLoading, setThresholdLoading] = useState(false);
  const [showThresholdSettings, setShowThresholdSettings] = useState(false);

  // Alias management
  const [showAliasModal, setShowAliasModal] = useState(false);
  const [managingProduct, setManagingProduct] = useState<Product | null>(null);
  const [aliases, setAliases] = useState<Array<{
    id: string;
    aliasDescription: string;
    status: string;
    createdAt: string;
  }>>([]);
  const [aliasesLoading, setAliasesLoading] = useState(false);
  const [editingAliasId, setEditingAliasId] = useState<string | null>(null);
  const [editAliasValue, setEditAliasValue] = useState('');
  const [newAliasValue, setNewAliasValue] = useState('');
  const [aliasError, setAliasError] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;

    const loadUoms = async () => {
      try {
        setUomLoading(true);
        const response = await fetch('/api/uom');
        if (!response.ok) {
          throw new Error('Failed to fetch UOM list');
        }

        const payload: unknown = await response.json();
        if (!cancelled) {
          setUomList(normalizeUomPayload(payload));
          setUomError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setUomError(err instanceof Error ? err.message : 'Failed to load UOM list');
          setUomList([]);
        }
      } finally {
        if (!cancelled) {
          setUomLoading(false);
        }
      }
    };

    loadUoms();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (uomList.length === 0) {
      if (createValues.uomCode) {
        setCreateValues(prev => (prev.uomCode ? { ...prev, uomCode: '' } : prev));
      }
      return;
    }

    if (createValues.type === 'JASA') {
      const jasaOption = uomList.find(option => option.code === DEFAULT_JASA_UOM_CODE);
      const currentValid = createValues.uomCode
        ? uomList.some(option => option.code === createValues.uomCode)
        : false;

      if (jasaOption && !currentValid) {
        setCreateValues(prev => ({ ...prev, uomCode: jasaOption.code }));
      }
    } else if (createValues.uomCode && !uomList.some(option => option.code === createValues.uomCode)) {
      setCreateValues(prev => ({ ...prev, uomCode: '' }));
    }
  }, [createValues.type, createValues.uomCode, uomList]);

  useEffect(() => {
    return () => {
      if (createHsSearchTimer.current) {
        clearTimeout(createHsSearchTimer.current);
        createHsSearchTimer.current = null;
      }
      if (createHsTooltipHideTimer.current) {
        clearTimeout(createHsTooltipHideTimer.current);
        createHsTooltipHideTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!createHsDropdownOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const inputEl = createHsInputRef.current;
      const dropdownEl = createHsDropdownRef.current;

      if (!inputEl) {
        return;
      }

      const clickedInsideInput = inputEl.contains(target);
      const clickedInsideDropdown = dropdownEl ? dropdownEl.contains(target) : false;

      if (!clickedInsideInput && !clickedInsideDropdown) {
        setCreateHsDropdownOpen(false);
        setCreateHsSelectedIndex(-1);
        setCreateHsTooltipVisible(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [createHsDropdownOpen]);

  useEffect(() => {
    if (!createHsSelectedData) {
      setCreateHsTooltipVisible(false);
    }
  }, [createHsSelectedData]);

  useEffect(() => {
    if (createHsDropdownOpen) {
      setCreateHsTooltipVisible(false);
    }
  }, [createHsDropdownOpen]);

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

  const resetCreateHsState = useCallback(() => {
    if (createHsSearchTimer.current) {
      clearTimeout(createHsSearchTimer.current);
      createHsSearchTimer.current = null;
    }
    if (createHsTooltipHideTimer.current) {
      clearTimeout(createHsTooltipHideTimer.current);
      createHsTooltipHideTimer.current = null;
    }
    setCreateHsSuggestions([]);
    setCreateHsDropdownOpen(false);
    setCreateHsSelectedIndex(-1);
    setCreateHsLastQuery('');
    setCreateHsError(null);
    setCreateHsLoading(false);
    setCreateHsSelectedData(null);
    setCreateHsTooltipVisible(false);
    setCreateHsTooltipLang('id');
    createHsLatestRequestRef.current = null;
  }, []);

  const openCreateModal = useCallback(() => {
    resetCreateHsState();
    setCreateValues({ description: '', hsCode: '', type: '', uomCode: '' });
    setShowCreateModal(true);
  }, [resetCreateHsState]);

  const closeCreateModal = useCallback(() => {
    setShowCreateModal(false);
    setCreateValues({ description: '', hsCode: '', type: '', uomCode: '' });
    resetCreateHsState();
  }, [resetCreateHsState]);

  const searchCreateHsCodes = useCallback((query: string, type: '' | 'BARANG' | 'JASA') => {
    if (createHsSearchTimer.current) {
      clearTimeout(createHsSearchTimer.current);
      createHsSearchTimer.current = null;
    }

    const trimmed = query.trim();
    setCreateHsError(null);

    if (!trimmed) {
      setCreateHsSuggestions([]);
      setCreateHsDropdownOpen(false);
      setCreateHsSelectedIndex(-1);
      setCreateHsLastQuery('');
      setCreateHsLoading(false);
      setCreateHsSelectedData(null);
      setCreateHsTooltipVisible(false);
      setCreateHsTooltipLang('id');
      createHsLatestRequestRef.current = null;
      return;
    }

    if (trimmed.length < 2) {
      setCreateHsSuggestions([]);
      setCreateHsDropdownOpen(false);
      setCreateHsSelectedIndex(-1);
      setCreateHsLastQuery(trimmed);
      setCreateHsLoading(false);
      setCreateHsSelectedData(null);
      setCreateHsTooltipVisible(false);
      setCreateHsTooltipLang('id');
      createHsLatestRequestRef.current = null;
      return;
    }

    setCreateHsLoading(true);
    setCreateHsDropdownOpen(true);
    setCreateHsLastQuery(trimmed);
    setCreateHsError(null);
    const requestMeta = { token: Symbol('hs-search') };
    createHsLatestRequestRef.current = requestMeta;

    createHsSearchTimer.current = setTimeout(async () => {
      try {
        const suggestions = await fetchHsCodeSuggestions(trimmed, type, 10);
        if (createHsLatestRequestRef.current === requestMeta) {
          setCreateHsSuggestions(suggestions);
          setCreateHsSelectedIndex(suggestions.length > 0 ? 0 : -1);
        }
      } catch (error) {
        console.error('Failed to search HS codes:', error);
        if (createHsLatestRequestRef.current === requestMeta) {
          setCreateHsSuggestions([]);
          setCreateHsError('Failed to search HS codes');
        }
      } finally {
        if (createHsLatestRequestRef.current === requestMeta) {
          setCreateHsLoading(false);
          createHsLatestRequestRef.current = null;
        }
        createHsSearchTimer.current = null;
      }
    }, 300);
  }, []);

  const selectCreateHsSuggestion = useCallback((suggestion: HsCodeSuggestion) => {
    if (createHsSearchTimer.current) {
      clearTimeout(createHsSearchTimer.current);
      createHsSearchTimer.current = null;
    }
    setCreateValues(prev => ({
      ...prev,
      hsCode: suggestion.code,
      type: suggestion.type,
    }));
    setCreateHsDropdownOpen(false);
    setCreateHsSuggestions([]);
    setCreateHsSelectedIndex(-1);
    setCreateHsLastQuery(suggestion.code);
    setCreateHsError(null);
    setCreateHsSelectedData(suggestion);
    setCreateHsTooltipLang('id');
    setCreateHsTooltipVisible(false);
    createHsLatestRequestRef.current = null;

    setTimeout(() => {
      if (createHsInputRef.current) {
        createHsInputRef.current.focus();
        const length = createHsInputRef.current.value.length;
        try {
          createHsInputRef.current.setSelectionRange(length, length);
        } catch {
          // Some input types do not support setSelectionRange; ignore
        }
      }
    }, 0);
  }, []);

  const handleCreateHsMouseEnter = useCallback(() => {
    if (createHsTooltipHideTimer.current) {
      clearTimeout(createHsTooltipHideTimer.current);
      createHsTooltipHideTimer.current = null;
    }
    if (!createHsSelectedData || createHsDropdownOpen) {
      return;
    }
    setCreateHsTooltipVisible(true);
  }, [createHsDropdownOpen, createHsSelectedData]);

  const handleCreateHsMouseLeave = useCallback(() => {
    if (createHsTooltipHideTimer.current) {
      clearTimeout(createHsTooltipHideTimer.current);
    }
    if (!createHsTooltipVisible) {
      return;
    }
    createHsTooltipHideTimer.current = setTimeout(() => {
      setCreateHsTooltipVisible(false);
      createHsTooltipHideTimer.current = null;
    }, 200);
  }, [createHsTooltipVisible]);

  const handleCreateHsTooltipMouseEnter = useCallback(() => {
    if (createHsTooltipHideTimer.current) {
      clearTimeout(createHsTooltipHideTimer.current);
      createHsTooltipHideTimer.current = null;
    }
  }, []);

  const handleCreateHsTooltipMouseLeave = useCallback(() => {
    if (createHsTooltipHideTimer.current) {
      clearTimeout(createHsTooltipHideTimer.current);
    }
    createHsTooltipHideTimer.current = setTimeout(() => {
      setCreateHsTooltipVisible(false);
      createHsTooltipHideTimer.current = null;
    }, 150);
  }, []);

  const handleCreateHsInputChange = useCallback((value: string) => {
    setCreateValues(prev => ({ ...prev, hsCode: value }));
    setCreateHsSelectedData(null);
    setCreateHsTooltipVisible(false);
    setCreateHsTooltipLang('id');
    searchCreateHsCodes(value, createValues.type);
  }, [searchCreateHsCodes, createValues.type]);

  const handleCreateHsFocus = () => {
    if (createHsTooltipHideTimer.current) {
      clearTimeout(createHsTooltipHideTimer.current);
      createHsTooltipHideTimer.current = null;
    }
    setCreateHsTooltipVisible(false);

    const trimmed = createValues.hsCode.trim();
    if (trimmed.length < 2) {
      return;
    }

    if (createHsSuggestions.length === 0 && !createHsLoading) {
      searchCreateHsCodes(trimmed, createValues.type);
    } else {
      setCreateHsDropdownOpen(true);
    }
  };

  const handleCreateHsKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!createHsDropdownOpen) {
      if (event.key === 'ArrowDown' && createHsSuggestions.length > 0) {
        event.preventDefault();
        setCreateHsDropdownOpen(true);
        setCreateHsSelectedIndex(prev => (prev >= 0 ? prev : 0));
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCreateHsSelectedIndex(prev => {
        if (createHsSuggestions.length === 0) return -1;
        const next = prev + 1;
        return next >= createHsSuggestions.length ? 0 : next;
      });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCreateHsSelectedIndex(prev => {
        if (createHsSuggestions.length === 0) return -1;
        if (prev <= 0) {
          return createHsSuggestions.length - 1;
        }
        return prev - 1;
      });
    } else if (event.key === 'Enter') {
      if (createHsSuggestions.length === 0) {
        return;
      }
      event.preventDefault();
      const index = createHsSelectedIndex >= 0 ? createHsSelectedIndex : 0;
      const suggestion = createHsSuggestions[index];
      if (suggestion) {
        selectCreateHsSuggestion(suggestion);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setCreateHsDropdownOpen(false);
      setCreateHsSelectedIndex(-1);
      setCreateHsTooltipVisible(false);
    }
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
      closeCreateModal();
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

  // Alias management functions
  const openAliasModal = async (product: Product) => {
    setManagingProduct(product);
    setShowAliasModal(true);
    setNewAliasValue('');
    setAliasError(null);
    await fetchAliases(product.id);
  };

  const closeAliasModal = () => {
    setShowAliasModal(false);
    setManagingProduct(null);
    setAliases([]);
    setEditingAliasId(null);
    setEditAliasValue('');
    setNewAliasValue('');
    setAliasError(null);
  };

  const fetchAliases = async (productId: string) => {
    try {
      setAliasesLoading(true);
      const response = await fetch(`/api/products/${productId}/aliases`);
      if (response.ok) {
        const data = await response.json();
        setAliases(data);
      }
    } catch (error) {
      console.error('Failed to fetch aliases:', error);
    } finally {
      setAliasesLoading(false);
    }
  };

  const handleAddAlias = async () => {
    if (!managingProduct || !newAliasValue.trim()) return;

    try {
      setAliasError(null);
      const response = await fetch(`/api/products/${managingProduct.id}/aliases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aliasDescription: newAliasValue.trim(),
          createdBy: 'admin',
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Failed to add alias');
      }

      await fetchAliases(managingProduct.id);
      await fetchProducts(); // Refresh products to update alias count
      setNewAliasValue('');
      showToast('Alias added successfully');
    } catch (error) {
      setAliasError(error instanceof Error ? error.message : 'Failed to add alias');
    }
  };

  const startEditAlias = (alias: { id: string; aliasDescription: string }) => {
    setEditingAliasId(alias.id);
    setEditAliasValue(alias.aliasDescription);
    setAliasError(null);
  };

  const cancelEditAlias = () => {
    setEditingAliasId(null);
    setEditAliasValue('');
    setAliasError(null);
  };

  const handleUpdateAlias = async (aliasId: string) => {
    if (!managingProduct || !editAliasValue.trim()) return;

    try {
      setAliasError(null);
      const response = await fetch(`/api/products/${managingProduct.id}/aliases/${aliasId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aliasDescription: editAliasValue.trim(),
          updatedBy: 'admin',
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Failed to update alias');
      }

      await fetchAliases(managingProduct.id);
      setEditingAliasId(null);
      setEditAliasValue('');
      showToast('Alias updated successfully');
    } catch (error) {
      setAliasError(error instanceof Error ? error.message : 'Failed to update alias');
    }
  };

  const handleDeleteAlias = async (aliasId: string) => {
    if (!managingProduct) return;
    if (!confirm('Are you sure you want to delete this alias?')) return;

    try {
      const response = await fetch(`/api/products/${managingProduct.id}/aliases/${aliasId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete alias');
      }

      await fetchAliases(managingProduct.id);
      await fetchProducts(); // Refresh products to update alias count
      showToast('Alias deleted successfully');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to delete alias', 'error');
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
          onClick={openCreateModal}
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
                              <select
                                value={editValues.uomCode || ''}
                                onChange={(e) => setEditValues({ ...editValues, uomCode: e.target.value })}
                                disabled={uomLoading || uomList.length === 0}
                                className={`w-32 px-2 py-1 border rounded focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                                  uomLoading || uomList.length === 0 ? 'bg-gray-100 text-gray-500 border-gray-200' : ''
                                }`}
                              >
                                <option value="">{uomLoading ? 'Loading...' : 'Select UOM'}</option>
                                {uomList.map(uom => (
                                  <option key={uom.code} value={uom.code}>
                                    {formatUomLabel(uom)}
                                  </option>
                                ))}
                              </select>
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
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-2">
                                <span className={`px-2 py-1 text-xs rounded font-medium ${
                                  (product.aliases?.length || 0) > 0
                                    ? 'bg-blue-100 text-blue-800'
                                    : 'bg-gray-100 text-gray-500'
                                }`}>
                                  {product.aliases?.length || 0}
                                </span>
                                <button
                                  onClick={() => openAliasModal(product)}
                                  className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                                  title="Manage aliases"
                                >
                                  Manage
                                </button>
                              </div>
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
                  onChange={(e) => setCreateValues(prev => ({ ...prev, description: e.target.value }))}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Product description"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Type
                </label>
                <select
                  value={createValues.type}
                  onChange={(e) => {
                    const nextType = e.target.value as '' | 'BARANG' | 'JASA';
                    setCreateValues(prev => {
                      let nextUomCode = prev.uomCode;
                      const isCurrentValid = nextUomCode
                        ? uomList.some(option => option.code === nextUomCode)
                        : false;

                      if (!isCurrentValid) {
                        nextUomCode = '';
                      }

                      if (nextType === 'JASA') {
                        const jasaOption = uomList.find(option => option.code === DEFAULT_JASA_UOM_CODE);
                        if (!nextUomCode && jasaOption) {
                          nextUomCode = jasaOption.code;
                        }
                      }

                      return { ...prev, type: nextType, uomCode: nextUomCode };
                    });
                    setCreateHsSelectedIndex(-1);
                    setCreateHsSelectedData(null);
                    setCreateHsSuggestions([]);
                    if (createHsTooltipHideTimer.current) {
                      clearTimeout(createHsTooltipHideTimer.current);
                      createHsTooltipHideTimer.current = null;
                    }
                    setCreateHsTooltipVisible(false);
                    setCreateHsTooltipLang('id');
                    setCreateHsError(null);
                    createHsLatestRequestRef.current = null;
                    const currentValue = createHsInputRef.current?.value ?? createValues.hsCode;
                    searchCreateHsCodes(currentValue, nextType);
                    setTimeout(() => {
                      if (createHsInputRef.current) {
                        createHsInputRef.current.focus();
                      }
                    }, 0);
                  }}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select type</option>
                  <option value="BARANG">BARANG</option>
                  <option value="JASA">JASA</option>
                </select>
                <p className="mt-1 text-xs text-gray-500">
                  Selecting a type narrows HS code suggestions.
                </p>
              </div>

              <div className="relative">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  HS Code
                </label>
                <div
                  className="relative"
                  onMouseEnter={handleCreateHsMouseEnter}
                  onMouseLeave={handleCreateHsMouseLeave}
                >
                  <input
                    ref={createHsInputRef}
                    type="text"
                    value={createValues.hsCode}
                    onChange={(e) => handleCreateHsInputChange(e.target.value)}
                    onFocus={handleCreateHsFocus}
                    onKeyDown={handleCreateHsKeyDown}
                    autoComplete="off"
                    className={`w-full px-3 py-2 pr-10 border rounded-lg focus:outline-none ${
                      createHsError
                        ? 'border-red-300 focus:ring-2 focus:ring-red-500 focus:border-red-400'
                        : 'border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
                    } font-mono text-sm`}
                    placeholder="Search HS codes by code or description"
                  />

                  {createHsSelectedData && (
                    <button
                      type="button"
                      className="absolute inset-y-0 right-2 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (createHsTooltipHideTimer.current) {
                          clearTimeout(createHsTooltipHideTimer.current);
                          createHsTooltipHideTimer.current = null;
                        }
                        setCreateHsTooltipVisible(prev => !prev);
                      }}
                      onFocus={(event) => {
                        event.stopPropagation();
                        if (createHsTooltipHideTimer.current) {
                          clearTimeout(createHsTooltipHideTimer.current);
                          createHsTooltipHideTimer.current = null;
                        }
                        setCreateHsTooltipVisible(true);
                      }}
                      onBlur={() => {
                        if (createHsTooltipHideTimer.current) {
                          clearTimeout(createHsTooltipHideTimer.current);
                        }
                        createHsTooltipHideTimer.current = setTimeout(() => {
                          setCreateHsTooltipVisible(false);
                          createHsTooltipHideTimer.current = null;
                        }, 150);
                      }}
                      aria-label="Toggle HS code details"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M12 5a7 7 0 100 14 7 7 0 000-14z" />
                      </svg>
                    </button>
                  )}

                  {createHsDropdownOpen && (
                    <div
                      ref={createHsDropdownRef}
                      className="absolute left-0 right-0 mt-1 max-h-72 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl z-30"
                    >
                      {createHsLoading ? (
                        <div className="flex items-center justify-center gap-2 py-4 text-sm text-gray-500">
                          <svg className="h-4 w-4 animate-spin text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                          Searching HS codes...
                        </div>
                      ) : createHsSuggestions.length > 0 ? (
                        <>
                          <div className="sticky top-0 bg-gray-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">
                            {createValues.type
                              ? `${formatHsTypeLabel(createValues.type)} HS Codes`
                              : 'HS Codes'}
                          </div>
                          {createHsSuggestions.map((suggestion, index) => (
                            <div
                              key={suggestion.id}
                              onMouseDown={(event) => {
                                event.preventDefault();
                                selectCreateHsSuggestion(suggestion);
                              }}
                              className={`cursor-pointer px-3 py-2 transition-colors ${
                                createHsSelectedIndex === index
                                  ? 'bg-blue-50'
                                  : 'hover:bg-gray-50'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-sm font-semibold text-gray-900">{suggestion.code}</span>
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                                  {formatHsTypeLabel(suggestion.type)} • {suggestion.level}
                                </span>
                              </div>
                              <div className="mt-1 text-xs text-gray-700 leading-snug">
                                {suggestion.descriptionEn}
                              </div>
                              <div className="mt-0.5 text-[11px] text-gray-500 leading-snug">
                                {suggestion.descriptionId}
                              </div>
                            </div>
                          ))}
                        </>
                      ) : createHsError ? (
                        <div className="px-3 py-2 text-sm text-red-600">
                          {createHsError}
                        </div>
                      ) : createHsLastQuery.length >= 2 ? (
                        <div className="px-3 py-3 text-sm text-gray-500">
                          No matching HS codes found.
                        </div>
                      ) : null}
                    </div>
                  )}

                  {createHsTooltipVisible && createHsSelectedData && (
                    <div
                      className="absolute top-full left-0 mt-2 w-[320px] max-w-[calc(100vw-4rem)] rounded-lg border border-gray-200 bg-white shadow-xl z-20"
                      role="tooltip"
                      style={{ pointerEvents: 'auto' }}
                      onMouseEnter={handleCreateHsTooltipMouseEnter}
                      onMouseLeave={handleCreateHsTooltipMouseLeave}
                    >
                      <div className="p-3">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs font-mono font-semibold text-gray-900">
                                {createHsSelectedData.code}
                              </span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                createHsSelectedData.type === 'BARANG'
                                  ? 'bg-blue-100 text-blue-700'
                                  : 'bg-green-100 text-green-700'
                              }`}>
                                {formatHsTypeLabel(createHsSelectedData.type)}
                              </span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-medium">
                                {createHsSelectedData.level}
                              </span>
                            </div>
                          </div>
                          <a
                            href={`/admin/hs-codes?search=${createHsSelectedData.code}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-shrink-0 text-blue-600 hover:text-blue-800 transition-colors"
                            title="Open in HS Code Management"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h6m0 0v6m0-6l-8 8M7 11V7a2 2 0 012-2h4" />
                            </svg>
                          </a>
                        </div>
                        <div className="border-t border-gray-100 pt-2">
                          <div className="flex items-center gap-1 mb-2">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setCreateHsTooltipLang('id');
                              }}
                              className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                                createHsTooltipLang === 'id'
                                  ? 'bg-blue-100 text-blue-700'
                                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                              }`}
                            >
                              🇮🇩 ID
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setCreateHsTooltipLang('en');
                              }}
                              className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                                createHsTooltipLang === 'en'
                                  ? 'bg-blue-100 text-blue-700'
                                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                              }`}
                            >
                              🇬🇧 EN
                            </button>
                          </div>
                          <div className="text-xs text-gray-700 leading-relaxed">
                            <p className="whitespace-pre-wrap break-words leading-snug">
                              {createHsTooltipLang === 'id'
                                ? (createHsSelectedData.descriptionId || 'Tidak ada deskripsi Bahasa Indonesia.')
                                : (createHsSelectedData.descriptionEn || 'No English description available.')}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  UOM Code
                </label>
                <select
                  value={createValues.uomCode}
                  onChange={(e) => setCreateValues(prev => ({ ...prev, uomCode: e.target.value }))}
                  disabled={uomLoading || uomList.length === 0}
                  className={`w-full px-3 py-2 border rounded-lg focus:outline-none ${
                    uomLoading || uomList.length === 0
                      ? 'bg-gray-100 text-gray-500 border-gray-200'
                      : 'focus:ring-2 focus:ring-blue-500 border-gray-300'
                  }`}
                >
                  <option value="">
                    {uomLoading ? 'Loading UOMs...' : 'Select UOM'}
                  </option>
                  {uomList.map(uom => (
                    <option key={uom.code} value={uom.code}>
                      {formatUomLabel(uom)}
                    </option>
                  ))}
                </select>
                {uomError && (
                  <p className="mt-1 text-xs text-red-600">{uomError}</p>
                )}
                {!uomLoading && !uomError && uomList.length === 0 && (
                  <p className="mt-1 text-xs text-gray-500">No UOM options available.</p>
                )}
              </div>
            </div>

            <div className="mt-6 flex justify-end space-x-3">
              <button
                onClick={closeCreateModal}
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

      {/* Alias Management Modal */}
      {showAliasModal && managingProduct && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold">Manage Aliases</h2>
                <p className="text-sm text-gray-600 mt-1">{managingProduct.description}</p>
              </div>
              <button
                onClick={closeAliasModal}
                className="text-gray-400 hover:text-gray-600"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {/* Error Message */}
              {aliasError && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                  {aliasError}
                </div>
              )}

              {/* Add New Alias */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Add New Alias
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newAliasValue}
                    onChange={(e) => setNewAliasValue(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleAddAlias()}
                    placeholder="Enter alternative product description"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={handleAddAlias}
                    disabled={!newAliasValue.trim()}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                  >
                    Add
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Aliases help the system recognize different ways to describe this product
                </p>
              </div>

              {/* Existing Aliases */}
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-3">
                  Existing Aliases ({aliases.length})
                </h3>

                {aliasesLoading ? (
                  <div className="text-center py-8 text-gray-500">Loading aliases...</div>
                ) : aliases.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 bg-gray-50 rounded-lg">
                    <svg className="w-12 h-12 mx-auto mb-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                    </svg>
                    <p className="font-medium">No aliases yet</p>
                    <p className="text-sm mt-1">Add your first alias above</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {aliases.map((alias) => (
                      <div
                        key={alias.id}
                        className="border border-gray-200 rounded-lg p-3 hover:bg-gray-50 transition-colors"
                      >
                        {editingAliasId === alias.id ? (
                          // Edit mode
                          <div className="space-y-2">
                            <input
                              type="text"
                              value={editAliasValue}
                              onChange={(e) => setEditAliasValue(e.target.value)}
                              onKeyPress={(e) => e.key === 'Enter' && handleUpdateAlias(alias.id)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                            <div className="flex gap-2 justify-end">
                              <button
                                onClick={() => handleUpdateAlias(alias.id)}
                                className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm font-medium"
                              >
                                Save
                              </button>
                              <button
                                onClick={cancelEditAlias}
                                className="px-3 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm font-medium"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          // View mode
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-gray-900 break-words">{alias.aliasDescription}</p>
                              <p className="text-xs text-gray-500 mt-1">
                                Added {new Date(alias.createdAt).toLocaleDateString()}
                              </p>
                            </div>
                            <div className="flex gap-2 flex-shrink-0">
                              <button
                                onClick={() => startEditAlias(alias)}
                                className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                                title="Edit alias"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                              </button>
                              <button
                                onClick={() => handleDeleteAlias(alias.id)}
                                className="text-red-600 hover:text-red-800 text-sm font-medium"
                                title="Delete alias"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end">
              <button
                onClick={closeAliasModal}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 font-medium"
              >
                Close
              </button>
            </div>
          </div>
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
