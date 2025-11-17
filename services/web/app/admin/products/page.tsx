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

interface DraftProduct {
  id: string;
  kind: 'new_product' | 'alias';
  description: string | null;
  hsCode: string | null;
  type: HsCodeType | null;
  uomCode: string | null;
  targetProductId: string | null;
  aliasDescription: string | null;
  sourceInvoiceId: string | null;
  sourcePdfLineText: string | null;
  confidenceScore: number | null;
  status: 'draft' | 'approved' | 'rejected';
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  createdAt: string;
  createdBy: string | null;
  enrichmentEvent?: {
    id: string;
    matchScore: number | null;
    matchedProductId: string | null;
    autoFilled: boolean;
    inputDescription: string | null;
    createdAt: string;
  } | null;
  targetProduct?: {
    id: string;
    description: string;
    hsCode: string | null;
    type: HsCodeType | null;
    uomCode: string | null;
  } | null;
  suggestedProduct?: {
    id: string;
    description: string;
    hsCode: string | null;
    type: HsCodeType | null;
    uomCode: string | null;
  } | null;
}

interface DraftEditorState {
  kind: 'new_product' | 'alias';
  description: string;
  hsCode: string;
  type: '' | 'BARANG' | 'JASA';
  uomCode: string;
  aliasDescription: string;
  targetProductId: string | null;
  targetProductLabel: string;
}

export default function ProductManagementPage() {
  const [viewMode, setViewMode] = useState<'active' | 'drafts'>('active');
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

  // Draft management state
  const [drafts, setDrafts] = useState<DraftProduct[]>([]);
  const [draftEditors, setDraftEditors] = useState<Record<string, DraftEditorState>>({});
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [draftStatusFilter, setDraftStatusFilter] = useState<'draft' | 'approved' | 'rejected' | ''>('draft');
  const [draftKindFilter, setDraftKindFilter] = useState<'new_product' | 'alias' | ''>('');
  const [draftPage, setDraftPage] = useState(1);
  const [draftTotalPages, setDraftTotalPages] = useState(1);
  const [draftTotal, setDraftTotal] = useState(0);
  const [draftActionLoading, setDraftActionLoading] = useState<string | null>(null);
  const [draftParentSearch, setDraftParentSearch] = useState<Record<string, { query: string; results: Product[]; loading: boolean }>>({});

  // Approval confirmation modal
  const [showApprovalConfirmation, setShowApprovalConfirmation] = useState(false);
  const [pendingApprovalDraft, setPendingApprovalDraft] = useState<DraftProduct | null>(null);

  const createDraftEditorState = useCallback((draft: DraftProduct): DraftEditorState => {
    const normalizedType: '' | 'BARANG' | 'JASA' = draft.type === 'BARANG' || draft.type === 'JASA' ? draft.type : '';

    return {
      kind: draft.kind,
      description: draft.description ?? '',
      hsCode: draft.hsCode ?? '',
      type: normalizedType,
      uomCode: draft.uomCode ?? '',
      aliasDescription: draft.aliasDescription ?? draft.description ?? '',
      targetProductId: draft.targetProduct?.id ?? draft.targetProductId,
      targetProductLabel: draft.targetProduct?.description ?? (draft.targetProductId ? draft.targetProductId : ''),
    };
  }, []);

  const fetchDrafts = useCallback(async () => {
    try {
      setDraftsLoading(true);
      setDraftsError(null);

      const params = new URLSearchParams();
      if (draftStatusFilter) params.append('status', draftStatusFilter);
      if (draftKindFilter) params.append('kind', draftKindFilter);
      params.append('page', draftPage.toString());
      params.append('pageSize', '20');

      const response = await fetch(`/api/products/drafts?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to load drafts');
      }

      const data = await response.json();
      const draftList: DraftProduct[] = data.drafts || [];

      setDrafts(draftList);
      setDraftTotal(data.total || 0);
      setDraftTotalPages(data.totalPages || 1);
      setDraftEditors(() => {
        const next: Record<string, DraftEditorState> = {};
        for (const draft of draftList) {
          next[draft.id] = createDraftEditorState(draft);
        }
        return next;
      });

      setDraftParentSearch(prev => {
        const next: Record<string, { query: string; results: Product[]; loading: boolean }> = {};
        for (const draft of draftList) {
          const baseline = createDraftEditorState(draft);
          const existing = prev[draft.id];
          next[draft.id] = {
            query: existing?.query ?? baseline.targetProductLabel ?? '',
            results: existing?.results ?? [],
            loading: false,
          };
        }
        return next;
      });
    } catch (err) {
      setDraftsError(err instanceof Error ? err.message : 'Failed to load drafts');
    } finally {
      setDraftsLoading(false);
    }
  }, [draftStatusFilter, draftKindFilter, draftPage, createDraftEditorState]);

  const updateDraftEditor = useCallback((id: string, updates: Partial<DraftEditorState>) => {
    setDraftEditors(prev => {
      const current = prev[id];
      if (!current) {
        return prev;
      }
      return {
        ...prev,
        [id]: {
          ...current,
          ...updates,
        },
      };
    });
  }, []);

  const setDraftEditorState = useCallback((id: string, nextState: DraftEditorState) => {
    setDraftEditors(prev => ({
      ...prev,
      [id]: nextState,
    }));
  }, []);

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

  useEffect(() => {
    if (viewMode !== 'drafts') {
      return;
    }
    fetchDrafts();
  }, [viewMode, fetchDrafts]);

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

  const patchDraft = useCallback(async (
    draftId: string,
    payload: Record<string, unknown>,
    successMessage?: string
  ) => {
    setDraftActionLoading(draftId);
    try {
      const response = await fetch(`/api/products/drafts/${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.error?.message || 'Failed to update draft');
      }

      await fetchDrafts();
      if (successMessage) {
        showToast(successMessage);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update draft', 'error');
    } finally {
      setDraftActionLoading(null);
    }
  }, [fetchDrafts, showToast]);

  const handleDraftKindChange = useCallback(async (draft: DraftProduct, newKind: 'new_product' | 'alias') => {
    const editor = draftEditors[draft.id] ?? createDraftEditorState(draft);

    if (editor.kind === newKind) {
      return;
    }

    let nextEditor = { ...editor, kind: newKind } as DraftEditorState;

    if (newKind === 'alias') {
      const fallbackAlias = editor.aliasDescription || editor.description || draft.description || '';
      const suggested = draft.suggestedProduct;
      nextEditor = {
        ...nextEditor,
        aliasDescription: fallbackAlias,
        hsCode: '',
        type: '',
        uomCode: '',
        targetProductId: editor.targetProductId ?? suggested?.id ?? null,
        targetProductLabel: editor.targetProductLabel || suggested?.description || (suggested?.id ?? ''),
      };
    } else {
      const baselineType: '' | 'BARANG' | 'JASA' = draft.type === 'BARANG' || draft.type === 'JASA' ? draft.type : '';
      nextEditor = {
        ...nextEditor,
        description: editor.description || draft.description || '',
        hsCode: editor.hsCode || draft.hsCode || '',
        type: editor.type || baselineType,
        uomCode: editor.uomCode || draft.uomCode || '',
        aliasDescription: '',
        targetProductId: null,
        targetProductLabel: '',
      };
    }

    setDraftEditorState(draft.id, nextEditor);

    const payload: Record<string, unknown> = {
      kind: newKind,
    };

    if (newKind === 'alias') {
      payload.hsCode = null;
      payload.type = null;
      payload.uomCode = null;
      payload.aliasDescription = nextEditor.aliasDescription;
      payload.targetProductId = nextEditor.targetProductId;
    } else {
      payload.description = nextEditor.description;
      payload.hsCode = nextEditor.hsCode || null;
      payload.type = nextEditor.type || null;
      payload.uomCode = nextEditor.uomCode || null;
      payload.aliasDescription = null;
      payload.targetProductId = null;
    }

    await patchDraft(
      draft.id,
      payload,
      newKind === 'alias' ? 'Draft set to Alias mode' : 'Draft set to New Product mode'
    );
  }, [createDraftEditorState, draftEditors, patchDraft, setDraftEditorState]);

  const handleDraftSave = useCallback(async (draft: DraftProduct) => {
    const editor = draftEditors[draft.id];
    if (!editor) {
      return;
    }

    if (editor.kind === 'new_product') {
      if (!editor.description.trim()) {
        showToast('Description is required for new products', 'error');
        return;
      }

      if (!editor.type) {
        showToast('Type is required for new products', 'error');
        return;
      }

      if (!editor.uomCode) {
        showToast('UOM needs to be selected for new products', 'error');
        return;
      }

      await patchDraft(draft.id, {
        kind: 'new_product',
        description: editor.description.trim(),
        hsCode: editor.hsCode.trim() ? editor.hsCode.trim() : null,
        type: editor.type,
        uomCode: editor.uomCode,
        aliasDescription: null,
        targetProductId: null,
      }, 'Draft updated');
      return;
    }

    if (!editor.aliasDescription.trim()) {
      showToast('Alias description cannot be empty', 'error');
      return;
    }

    if (!editor.targetProductId) {
      showToast('Select a parent product for this alias', 'error');
      return;
    }

    await patchDraft(draft.id, {
      kind: 'alias',
      aliasDescription: editor.aliasDescription.trim(),
      targetProductId: editor.targetProductId,
      hsCode: null,
      type: null,
      uomCode: null,
    }, 'Draft updated');
  }, [draftEditors, patchDraft, showToast]);

  const handleDraftApprove = useCallback(async (draft: DraftProduct) => {
    const editor = draftEditors[draft.id];
    if (!editor) {
      return;
    }

    // Validate required fields
    if (editor.kind === 'new_product') {
      if (!editor.description.trim()) {
        showToast('Description is required before approval', 'error');
        return;
      }
      if (!editor.type) {
        showToast('Select product type before approval', 'error');
        return;
      }
      if (!editor.uomCode) {
        showToast('Select UOM before approval', 'error');
        return;
      }
    } else {
      if (!editor.aliasDescription.trim()) {
        showToast('Alias description cannot be empty', 'error');
        return;
      }
      if (!editor.targetProductId) {
        showToast('Assign a parent product before approving alias', 'error');
        return;
      }
    }

    // Auto-save draft before showing confirmation
    setDraftActionLoading(draft.id);
    try {
      const savePayload: Record<string, unknown> = editor.kind === 'new_product'
        ? {
            kind: 'new_product',
            description: editor.description.trim(),
            hsCode: editor.hsCode.trim() ? editor.hsCode.trim() : null,
            type: editor.type,
            uomCode: editor.uomCode,
            aliasDescription: null,
            targetProductId: null,
          }
        : {
            kind: 'alias',
            aliasDescription: editor.aliasDescription.trim(),
            targetProductId: editor.targetProductId,
            hsCode: null,
            type: null,
            uomCode: null,
          };

      const saveResponse = await fetch(`/api/products/drafts/${draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(savePayload),
      });

      if (!saveResponse.ok) {
        const errorData = await saveResponse.json().catch(() => null);
        throw new Error(errorData?.error?.message || 'Failed to save draft');
      }

      const responseData = await saveResponse.json();
      const savedDraft = responseData.draft;

      // Update editor state with saved draft data
      const updatedEditor = createDraftEditorState(savedDraft);
      setDraftEditors(prev => ({
        ...prev,
        [savedDraft.id]: updatedEditor,
      }));

      // Refresh drafts to get updated data
      await fetchDrafts();

      // Show confirmation modal
      setPendingApprovalDraft(savedDraft);
      setShowApprovalConfirmation(true);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to prepare draft for approval', 'error');
    } finally {
      setDraftActionLoading(null);
    }
  }, [draftEditors, createDraftEditorState, fetchDrafts, showToast]);

  const handleConfirmApproval = useCallback(async () => {
    if (!pendingApprovalDraft) {
      return;
    }

    const editor = draftEditors[pendingApprovalDraft.id];
    if (!editor) {
      return;
    }

    const payload: Record<string, unknown> = {
      action: 'approve',
      reviewedBy: 'catalog-admin',
      reviewNotes: null,
      updates: editor.kind === 'new_product'
        ? {
            description: editor.description.trim(),
            hsCode: editor.hsCode.trim() ? editor.hsCode.trim() : null,
            type: editor.type,
            uomCode: editor.uomCode,
            aliasDescription: null,
            targetProductId: null,
          }
        : {
            aliasDescription: editor.aliasDescription.trim(),
            targetProductId: editor.targetProductId,
            hsCode: null,
            type: null,
            uomCode: null,
            description: editor.description.trim(),
          },
    };

    setDraftActionLoading(pendingApprovalDraft.id);
    setShowApprovalConfirmation(false);
    try {
      const response = await fetch(`/api/products/drafts/${pendingApprovalDraft.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.error?.message || 'Failed to approve draft');
      }

      showToast('Draft approved and published successfully');
      setPendingApprovalDraft(null);
      await fetchDrafts();
      await fetchProducts();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to approve draft', 'error');
    } finally {
      setDraftActionLoading(null);
    }
  }, [pendingApprovalDraft, draftEditors, fetchDrafts, fetchProducts, showToast]);

  const handleCancelApproval = useCallback(() => {
    setShowApprovalConfirmation(false);
    setPendingApprovalDraft(null);
  }, []);

  const handleDraftReject = useCallback(async (draft: DraftProduct) => {
    const notes = typeof window !== 'undefined'
      ? window.prompt('Add a note for rejection (optional):')
      : '';

    if (notes === null) {
      return;
    }

    setDraftActionLoading(draft.id);
    try {
      const response = await fetch(`/api/products/drafts/${draft.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reject',
          reviewedBy: 'catalog-admin',
          reviewNotes: notes?.trim() ? notes.trim() : null,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.error?.message || 'Failed to reject draft');
      }

      showToast('Draft rejected');
      await fetchDrafts();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to reject draft', 'error');
    } finally {
      setDraftActionLoading(null);
    }
  }, [fetchDrafts, showToast]);

  const handleParentSearch = useCallback(async (draftId: string, query: string) => {
    setDraftParentSearch(prev => ({
      ...prev,
      [draftId]: {
        query,
        results: query.trim() === '' ? [] : prev[draftId]?.results || [],
        loading: query.trim() !== '' ,
      },
    }));

    if (!query.trim()) {
      setDraftParentSearch(prev => ({
        ...prev,
        [draftId]: {
          query: '',
          results: [],
          loading: false,
        },
      }));
      return;
    }

    try {
      const params = new URLSearchParams({
        search: query.trim(),
        status: 'active',
        page: '1',
        pageSize: '10',
      });

      const response = await fetch(`/api/products?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Search failed');
      }

      const data = await response.json();
      const results: Product[] = data.products || [];
      setDraftParentSearch(prev => ({
        ...prev,
        [draftId]: {
          query,
          results,
          loading: false,
        },
      }));
    } catch (err) {
      setDraftParentSearch(prev => ({
        ...prev,
        [draftId]: {
          query,
          results: [],
          loading: false,
        },
      }));
    }
  }, []);

  const handleSelectParentProduct = useCallback((draftId: string, product: { id: string; description: string }) => {
    updateDraftEditor(draftId, {
      targetProductId: product.id,
      targetProductLabel: product.description,
    });

    setDraftParentSearch(prev => ({
      ...prev,
      [draftId]: {
        query: product.description,
        results: [],
        loading: false,
      },
    }));
  }, [updateDraftEditor]);

  const renderDraftsView = () => {
    const emptyState = !draftsLoading && !draftsError && drafts.length === 0;

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3 bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
          <div className="flex gap-3">
            <select
              value={draftStatusFilter}
              onChange={(e) => {
                setDraftStatusFilter(e.target.value as typeof draftStatusFilter);
                setDraftPage(1);
              }}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            >
              <option value="">All Status</option>
              <option value="draft">Pending Review</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>

            <select
              value={draftKindFilter}
              onChange={(e) => {
                setDraftKindFilter(e.target.value as typeof draftKindFilter);
                setDraftPage(1);
              }}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            >
              <option value="">All Draft Types</option>
              <option value="new_product">New Product</option>
              <option value="alias">Alias</option>
            </select>
          </div>

          <div className="flex items-center gap-3 ml-auto">
            <span className="text-sm text-gray-600">
              Showing {drafts.length} of {draftTotal} draft(s)
            </span>
            <button
              onClick={fetchDrafts}
              className="px-3 py-2 text-sm text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>

        {draftsError && (
          <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
            {draftsError}
          </div>
        )}

        {draftsLoading ? (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-500 shadow-sm">
            Loading draft products...
          </div>
        ) : emptyState ? (
          <div className="bg-white border border-dashed border-gray-300 rounded-2xl p-12 text-center text-gray-500">
            <svg className="w-10 h-10 mx-auto mb-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2a2 2 0 012-2h2a2 2 0 012 2v2m-6 0h6" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
            <h3 className="text-lg font-semibold text-gray-700">No drafts waiting</h3>
            <p className="mt-2 text-sm text-gray-500">
              When invoices introduce unfamiliar products, they will land here automatically for review.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {drafts.map((draft) => {
              const editor = draftEditors[draft.id] ?? createDraftEditorState(draft);
              const parentSearch = draftParentSearch[draft.id];
              const isAlias = editor.kind === 'alias';
              const actionDisabled = draftActionLoading === draft.id;
              const suggested = draft.suggestedProduct;

              const confidenceDisplay = draft.confidenceScore !== null
                ? `${Math.round(draft.confidenceScore * 100)}%`
                : draft.enrichmentEvent?.matchScore !== null && draft.enrichmentEvent?.matchScore !== undefined
                  ? `${Math.round((draft.enrichmentEvent.matchScore || 0) * 100)}%`
                  : null;

              const parentSearchValue = parentSearch?.query ?? editor.targetProductLabel ?? '';

              return (
                <div
                  key={draft.id}
                  className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 space-y-5"
                >
                  <div className="flex flex-wrap items-start gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs uppercase tracking-wide text-gray-500">
                        Draft #{draft.id.slice(0, 8)}
                      </div>
                      <h3 className="mt-1 text-lg font-semibold text-gray-900 break-words">
                        {isAlias
                          ? (editor.aliasDescription || 'Alias needs a friendly name')
                          : (editor.description || 'Describe this product')}
                      </h3>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500">
                        {draft.sourceInvoiceId && (
                          <span className="px-2 py-1 bg-gray-100 rounded-full">Invoice {draft.sourceInvoiceId}</span>
                        )}
                        {draft.sourcePdfLineText && (
                          <span className="px-2 py-1 bg-gray-100 rounded-full">
                            “{draft.sourcePdfLineText.slice(0, 40)}{draft.sourcePdfLineText.length > 40 ? '…' : ''}”
                          </span>
                        )}
                        {confidenceDisplay && (
                          <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded-full">
                            Match confidence {confidenceDisplay}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-2">
                      <span className="px-3 py-1 text-xs font-medium rounded-full bg-yellow-100 text-yellow-700 uppercase">
                        {draft.status}
                      </span>
                      <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
                        <button
                          onClick={() => handleDraftKindChange(draft, 'new_product')}
                          className={`px-4 py-2 text-sm font-medium transition-colors ${
                            !isAlias ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          New Product
                        </button>
                        <button
                          onClick={() => handleDraftKindChange(draft, 'alias')}
                          className={`px-4 py-2 text-sm font-medium transition-colors ${
                            isAlias ? 'bg-purple-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          Alias
                        </button>
                      </div>
                    </div>
                  </div>

                  {suggested && (
                    <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-purple-800">
                            Suggested parent product
                          </p>
                          <p className="text-sm text-purple-700 break-words">
                            {suggested.description}
                          </p>
                          <p className="text-xs text-purple-600">
                            HS {suggested.hsCode ?? '—'} · {suggested.type ?? '—'} · {suggested.uomCode ?? '—'}
                          </p>
                        </div>
                        <button
                          onClick={() => handleSelectParentProduct(draft.id, { id: suggested.id, description: suggested.description })}
                          className="px-3 py-2 text-sm font-medium text-purple-700 bg-white border border-purple-200 rounded-lg hover:bg-purple-100"
                        >
                          Use suggested parent
                        </button>
                      </div>
                      <p className="text-xs text-purple-700">
                        Aligned aliases inherit Type, HS Code, and UOM automatically.
                      </p>
                    </div>
                  )}

                  {isAlias ? (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Alias Description
                        </label>
                        <textarea
                          value={editor.aliasDescription}
                          onChange={(e) => updateDraftEditor(draft.id, { aliasDescription: e.target.value })}
                          rows={3}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                          placeholder="How does this appear on invoices?"
                        />
                        <p className="mt-1 text-xs text-gray-500">
                          Keep the original description intact so the system can match future invoices reliably.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <label className="block text-sm font-medium text-gray-700">
                          Assign Parent Product
                        </label>
                        <input
                          type="text"
                          value={parentSearchValue}
                          onChange={(e) => handleParentSearch(draft.id, e.target.value)}
                          placeholder="Search by product name, HS code, or keyword"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                        />
                        {parentSearch?.loading && (
                          <div className="text-xs text-purple-600">Searching...</div>
                        )}
                        {!parentSearch?.loading && parentSearch?.results?.length > 0 && (
                          <div className="border border-gray-200 rounded-lg divide-y max-h-48 overflow-y-auto">
                            {parentSearch.results.map((product) => (
                              <button
                                key={product.id}
                                type="button"
                                onClick={() => handleSelectParentProduct(draft.id, product)}
                                className="w-full text-left px-3 py-2 hover:bg-blue-50 transition-colors"
                              >
                                <div className="text-sm font-medium text-gray-800">{product.description}</div>
                                <div className="text-xs text-gray-500">
                                  HS {product.hsCode ?? '—'} · {product.type ?? '—'} · {product.uomCode ?? '—'}
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                        {editor.targetProductId && (
                          <p className="text-xs text-green-600">
                            Linked to {editor.targetProductLabel || editor.targetProductId}
                          </p>
                        )}
                        <p className="text-xs text-gray-500">
                          Tip: as you type, the list narrows to matching products. Look for a description that already carries the correct HS code and UOM.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Product Description
                        </label>
                        <textarea
                          value={editor.description}
                          onChange={(e) => updateDraftEditor(draft.id, { description: e.target.value })}
                          rows={3}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder="Summarize the product clearly"
                        />
                      </div>

                      <div className="grid gap-4 md:grid-cols-3">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Type
                          </label>
                          <select
                            value={editor.type}
                            onChange={(e) => {
                              const nextType = e.target.value as '' | 'BARANG' | 'JASA';
                              let nextUom = editor.uomCode;
                              if (nextType === 'JASA') {
                                const jasaDefault = uomList.find(u => u.code === DEFAULT_JASA_UOM_CODE);
                                if (jasaDefault) {
                                  nextUom = jasaDefault.code;
                                }
                              }
                              updateDraftEditor(draft.id, { type: nextType, uomCode: nextUom || '' });
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <option value="">Choose type</option>
                            <option value="BARANG">BARANG</option>
                            <option value="JASA">JASA</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            HS Code
                          </label>
                          <input
                            type="text"
                            value={editor.hsCode}
                            onChange={(e) => {
                              const cleaned = e.target.value.replace(/[^0-9]/g, '').slice(0, 6);
                              updateDraftEditor(draft.id, { hsCode: cleaned });
                            }}
                            placeholder="6 digits"
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            UOM
                          </label>
                          <select
                            value={editor.uomCode}
                            onChange={(e) => updateDraftEditor(draft.id, { uomCode: e.target.value })}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <option value="">Select UOM</option>
                            {uomList.map(uom => (
                              <option key={uom.code} value={uom.code}>
                                {formatUomLabel(uom)}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <p className="text-xs text-gray-500">
                        Once approved, this product becomes available for automatic matching and enrichment.
                      </p>
                    </div>
                  )}

                  <div className="pt-4 border-t border-gray-200 flex flex-wrap items-center justify-between gap-3">
                    <div className="text-xs text-gray-500">
                      Created {new Date(draft.createdAt).toLocaleString()}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => handleDraftSave(draft)}
                        disabled={actionDisabled}
                        className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                          actionDisabled
                            ? 'border-gray-200 text-gray-400 cursor-not-allowed'
                            : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        Save Draft
                      </button>
                      <button
                        onClick={() => handleDraftApprove(draft)}
                        disabled={actionDisabled}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                          actionDisabled
                            ? 'bg-green-200 text-white cursor-not-allowed'
                            : 'bg-green-600 text-white hover:bg-green-700'
                        }`}
                      >
                        Approve & Publish
                      </button>
                      <button
                        onClick={() => handleDraftReject(draft)}
                        disabled={actionDisabled}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                          actionDisabled
                            ? 'bg-red-200 text-white cursor-not-allowed'
                            : 'bg-red-600 text-white hover:bg-red-700'
                        }`}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {draftTotalPages > 1 && (
          <div className="flex items-center justify-center gap-4">
            <button
              onClick={() => setDraftPage(prev => Math.max(1, prev - 1))}
              disabled={draftPage === 1}
              className={`px-4 py-2 rounded-lg border text-sm font-medium ${
                draftPage === 1
                  ? 'border-gray-200 text-gray-400 cursor-not-allowed'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              Previous
            </button>
            <span className="text-sm text-gray-600">
              Page {draftPage} of {draftTotalPages}
            </span>
            <button
              onClick={() => setDraftPage(prev => Math.min(draftTotalPages, prev + 1))}
              disabled={draftPage === draftTotalPages}
              className={`px-4 py-2 rounded-lg border text-sm font-medium ${
                draftPage === draftTotalPages
                  ? 'border-gray-200 text-gray-400 cursor-not-allowed'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              Next
            </button>
          </div>
        )}
      </div>
    );
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

      <div className="mb-6 flex flex-wrap gap-3">
        <button
          onClick={() => {
            setViewMode('active');
            setPage(1);
          }}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            viewMode === 'active'
              ? 'bg-blue-600 text-white shadow'
              : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'
          }`}
        >
          Active Products
        </button>
        <button
          onClick={() => {
            setViewMode('drafts');
            setDraftPage(1);
          }}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            viewMode === 'drafts'
              ? 'bg-purple-600 text-white shadow'
              : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'
          }`}
        >
          Draft Products
        </button>
      </div>

      {viewMode === 'active' ? (
        <>
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

        </>
      ) : (
        renderDraftsView()
      )}

      {/* Create Modal */}
      {viewMode === 'active' && showCreateModal && (
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
      {viewMode === 'active' && showAliasModal && managingProduct && (
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

      {/* Approval Confirmation Modal */}
      {showApprovalConfirmation && pendingApprovalDraft && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-gray-900">Confirm Publication</h2>
                <button
                  onClick={handleCancelApproval}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                  aria-label="Close"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <p className="text-sm text-gray-600 mt-1">
                Review the details below before publishing to the live catalog
              </p>
            </div>

            {/* Modal Body */}
            <div className="px-6 py-4">
              {(() => {
                const editor = draftEditors[pendingApprovalDraft.id];
                if (!editor) return null;

                if (editor.kind === 'new_product') {
                  return (
                    <div className="space-y-4">
                      {/* Product Type Badge */}
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">
                          <svg className="w-4 h-4 mr-1.5" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"/>
                          </svg>
                          New Product
                        </span>
                      </div>

                      {/* Product Details */}
                      <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                            Description
                          </label>
                          <p className="text-base font-medium text-gray-900">{editor.description}</p>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                              HS Code
                            </label>
                            <p className="text-sm text-gray-900">
                              {editor.hsCode || <span className="text-gray-400 italic">Not specified</span>}
                            </p>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                              Type
                            </label>
                            <p className="text-sm text-gray-900">
                              {editor.type ? formatHsTypeLabel(editor.type) : <span className="text-gray-400 italic">Not specified</span>}
                            </p>
                          </div>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                            Unit of Measure
                          </label>
                          <p className="text-sm text-gray-900">
                            {editor.uomCode ? (
                              (() => {
                                const uom = uomList.find(u => u.code === editor.uomCode);
                                return uom ? formatUomLabel(uom) : editor.uomCode;
                              })()
                            ) : (
                              <span className="text-gray-400 italic">Not specified</span>
                            )}
                          </p>
                        </div>
                      </div>

                      {/* Info Alert */}
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex gap-3">
                        <svg className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/>
                        </svg>
                        <div className="text-sm text-blue-800">
                          <p className="font-medium">This product will be added to the live catalog</p>
                          <p className="mt-1">It will be available for automatic matching and can be used in invoices.</p>
                        </div>
                      </div>
                    </div>
                  );
                } else {
                  // Alias
                  return (
                    <div className="space-y-4">
                      {/* Alias Type Badge */}
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-purple-100 text-purple-800">
                          <svg className="w-4 h-4 mr-1.5" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z"/>
                            <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z"/>
                          </svg>
                          Product Alias
                        </span>
                      </div>

                      {/* Alias Details */}
                      <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                            Alias Description
                          </label>
                          <p className="text-base font-medium text-gray-900">{editor.aliasDescription}</p>
                        </div>

                        <div className="border-t border-gray-200 pt-3">
                          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                            Links to Parent Product
                          </label>
                          <div className="bg-white rounded-lg border border-gray-200 p-3">
                            <p className="text-sm font-medium text-gray-900 mb-2">{editor.targetProductLabel}</p>
                            {pendingApprovalDraft.targetProduct && (
                              <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
                                {pendingApprovalDraft.targetProduct.hsCode && (
                                  <div>
                                    <span className="text-gray-500">HS Code:</span> {pendingApprovalDraft.targetProduct.hsCode}
                                  </div>
                                )}
                                {pendingApprovalDraft.targetProduct.type && (
                                  <div>
                                    <span className="text-gray-500">Type:</span> {formatHsTypeLabel(pendingApprovalDraft.targetProduct.type)}
                                  </div>
                                )}
                                {pendingApprovalDraft.targetProduct.uomCode && (
                                  <div className="col-span-2">
                                    <span className="text-gray-500">UOM:</span> {pendingApprovalDraft.targetProduct.uomCode}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Info Alert */}
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex gap-3">
                        <svg className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/>
                        </svg>
                        <div className="text-sm text-blue-800">
                          <p className="font-medium">This alias will be added to the live catalog</p>
                          <p className="mt-1">Future matches for &ldquo;{editor.aliasDescription}&rdquo; will automatically link to the parent product.</p>
                        </div>
                      </div>
                    </div>
                  );
                }
              })()}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end gap-3">
              <button
                onClick={handleCancelApproval}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmApproval}
                className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors shadow-sm"
              >
                <span className="flex items-center gap-2">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/>
                  </svg>
                  Confirm & Publish
                </span>
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
