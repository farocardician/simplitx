'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import BuyerDropdown from '@/components/BuyerDropdown';
import TransactionCodeDropdown from '@/components/TransactionCodeDropdown';

interface LineItemBase {
  no?: number;
  description: string;
  qty: number;
  unit_price: number;
  amount: number;
  sku?: string | null;
  hs_code: string | null;
  uom: string;
  type: 'Barang' | 'Jasa';
  taxRate?: number | null;
}

interface LineItem extends LineItemBase {
  id: string;
  orderKey: number;
  mergeSnapshot?: MergeSnapshot | null;
  roundingAdjustment?: number;
  taxRate: number;
}

interface StoredItemState extends LineItemBase {
  id: string;
  orderKey: number;
  taxRate: number;
}

interface MergeSnapshot {
  mergeId: string;
  anchor: StoredItemState;
  components: StoredItemState[];
  totalAmount: number;
  roundingAdjustment?: number;
}

interface ResolvedParty {
  id: string;
  displayName: string;
  tinDisplay: string;
  countryCode: string | null;
  addressFull: string | null;
  email: string | null;
  buyerDocument: string | null;
  buyerDocumentNumber: string | null;
  buyerIdtku: string | null;
  transactionCode: string | null;
}

interface CandidateParty extends ResolvedParty {
  confidence: number;
}

interface InvoiceData {
  invoice_number: string;
  seller_name: string;
  buyer_name: string;
  invoice_date: string;
  items: LineItemBase[];
  trx_code: string | null;
  trx_code_required: boolean;
  buyer_resolved?: ResolvedParty | null;
  buyer_candidates?: CandidateParty[];
  buyer_resolution_status?: string;
  buyer_unresolved?: boolean;
  buyer_resolution_confidence?: number | null;
}

interface UOM {
  code: string;
  name: string;
}

interface TransactionCode {
  code: string;
  name: string;
  description: string;
}

interface ItemErrors {
  description?: string;
  qty?: string;
  unit_price?: string;
  hs_code?: string;
  uom?: string;
  type?: string;
}

interface HsCodeData {
  code: string;
  type: 'BARANG' | 'JASA';
  descriptionId: string;
  descriptionEn: string;
  level: string;
}

interface HsCodeValidation {
  isValid: boolean;
  warning?: string;
  data?: HsCodeData;
}

interface HsCodeSuggestion {
  id: string;
  code: string;
  type: 'BARANG' | 'JASA';
  level: string;
  descriptionEn: string;
  descriptionId: string;
}

// Default UOM to use when a line item is marked as "Jasa"
const JASA_UOM_CODE = 'UM.0030';

const generateItemId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `item-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};

const createStoredState = (item: LineItem): StoredItemState => ({
  id: item.id,
  orderKey: item.orderKey,
  no: item.no,
  description: item.description,
  qty: item.qty,
  unit_price: item.unit_price,
  amount: item.amount,
  sku: item.sku ?? null,
  hs_code: item.hs_code,
  uom: item.uom,
  type: item.type,
  taxRate: item.taxRate
});

const createLineItemState = (item: LineItemBase, orderKey: number): LineItem => {
  const rawTaxRate = (() => {
    const fromCamel = item.taxRate;
    const fromSnake = (item as unknown as { tax_rate?: number | null }).tax_rate;
    const candidate = typeof fromCamel === 'number' ? fromCamel : fromSnake;
    return typeof candidate === 'number' && !Number.isNaN(candidate)
      ? candidate
      : 12;
  })();

  return {
    ...item,
    id: generateItemId(),
    orderKey,
    mergeSnapshot: null,
    taxRate: rawTaxRate
  };
};

const cloneStoredState = (stored: StoredItemState): StoredItemState => ({ ...stored });

const restoreFromStored = (stored: StoredItemState): LineItem => ({
  ...stored,
  mergeSnapshot: null,
  roundingAdjustment: undefined
});

const flattenStoredItems = (item: LineItem): StoredItemState[] => {
  if (item.mergeSnapshot) {
    return [
      cloneStoredState(item.mergeSnapshot.anchor),
      ...item.mergeSnapshot.components.map(component => cloneStoredState(component))
    ];
  }

  return [createStoredState(item)];
};

const buildErrors = (list: LineItem[], validator: (item: LineItem, index: number) => ItemErrors) => {
  const newErrors: Record<number, ItemErrors> = {};
  list.forEach((item, index) => {
    const itemErrors = validator(item, index);
    if (Object.keys(itemErrors).length > 0) {
      newErrors[index] = itemErrors;
    }
  });
  return newErrors;
};

export default function ReviewPage() {
  const params = useParams();
  const router = useRouter();
  const jobId = params?.jobId as string;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [invoiceData, setInvoiceData] = useState<InvoiceData | null>(null);
  const [invoiceDate, setInvoiceDate] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [items, setItems] = useState<LineItem[]>([]);
  const [initialSnapshot, setInitialSnapshot] = useState<{
    invoiceDate: string;
    invoiceNo: string;
    items: StoredItemState[];
    trxCode: string | null;
  } | null>(null);
  const orderKeyRef = useRef(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [uomList, setUomList] = useState<UOM[]>([]);
  const [errors, setErrors] = useState<Record<number, ItemErrors>>({});
  const [applyToAllState, setApplyToAllState] = useState<{
    itemIndex: number;
    type: 'Barang' | 'Jasa';
  } | null>(null);
  const [applyToAllUom, setApplyToAllUom] = useState<{
    itemIndex: number;
    uomCode: string;
  } | null>(null);
  const [selectedBuyerPartyId, setSelectedBuyerPartyId] = useState<string | null>(null);
  const [allParties, setAllParties] = useState<CandidateParty[]>([]);
  const [transactionCodes, setTransactionCodes] = useState<TransactionCode[]>([]);
  const [focusedDescriptionIndex, setFocusedDescriptionIndex] = useState<number | null>(null);
  const [hoveredDescription, setHoveredDescription] = useState<{
    index: number;
    position: 'top' | 'bottom';
  } | null>(null);
  const descriptionFieldRefs = useRef<Array<HTMLDivElement | null>>([]);
  const descriptionInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [descriptionTruncationMap, setDescriptionTruncationMap] = useState<Record<number, boolean>>({});

  // HS Code validation and hover states
  const [hsCodeValidations, setHsCodeValidations] = useState<Record<number, HsCodeValidation>>({});
  const [hoveredHsCode, setHoveredHsCode] = useState<{
    index: number;
    position: 'top' | 'bottom';
  } | null>(null);
  const [hsCodeTooltipLang, setHsCodeTooltipLang] = useState<Record<number, 'id' | 'en'>>({});
  const hsCodeFieldRefs = useRef<Array<HTMLDivElement | null>>([]);
  const hsCodeDebounceTimers = useRef<Record<number, NodeJS.Timeout>>({});
  const hsCodeHideTimeout = useRef<NodeJS.Timeout | null>(null);

  // HS Code autocomplete states
  const [hsCodeSuggestions, setHsCodeSuggestions] = useState<Record<number, HsCodeSuggestion[]>>({});
  const [hsCodeSearchLoading, setHsCodeSearchLoading] = useState<Record<number, boolean>>({});
  const [focusedHsCodeIndex, setFocusedHsCodeIndex] = useState<number | null>(null);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState<Record<number, number>>({});
  const hsCodeSearchTimers = useRef<Record<number, NodeJS.Timeout>>({});
  const hsCodeInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const hsCodeDropdownRefs = useRef<Array<HTMLDivElement | null>>([]);

  // HS Code preservation per type - stores last valid code for each type per item
  const hsCodeMemory = useRef<Record<number, { barang: string | null; jasa: string | null }>>({});

  const recomputeDescriptionTruncation = useCallback(() => {
    const next: Record<number, boolean> = {};

    descriptionInputRefs.current.forEach((input, index) => {
      if (!input) {
        return;
      }
      const isTruncated = input.scrollWidth - input.clientWidth > 0.5;
      if (isTruncated) {
        next[index] = true;
      }
    });

    setDescriptionTruncationMap(prev => {
      const allIndexes = new Set<number>([
        ...Object.keys(prev).map(key => Number(key)),
        ...Object.keys(next).map(key => Number(key))
      ]);

      let changed = false;

      allIndexes.forEach(idx => {
        if (Boolean(prev[idx]) !== Boolean(next[idx])) {
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const frame = window.requestAnimationFrame(recomputeDescriptionTruncation);
    return () => window.cancelAnimationFrame(frame);
  }, [items, focusedDescriptionIndex, recomputeDescriptionTruncation]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleResize = () => {
      recomputeDescriptionTruncation();
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [recomputeDescriptionTruncation]);

  const isDescriptionTextTruncated = (index: number) => {
    if (descriptionTruncationMap[index]) {
      return true;
    }

    const input = descriptionInputRefs.current[index];
    if (!input) {
      return false;
    }

    return input.scrollWidth - input.clientWidth > 0.5;
  };

  // HS Code validation and hover handlers (defined before useEffects that use them)
  const validateHsCode = useCallback(async (index: number, code: string, type: 'Barang' | 'Jasa') => {
    // Clear existing timer for this index
    if (hsCodeDebounceTimers.current[index]) {
      clearTimeout(hsCodeDebounceTimers.current[index]);
    }

    // If code is empty or not digits only, clear validation
    if (!code || !/^\d+$/.test(code)) {
      setHsCodeValidations(prev => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      return;
    }

    // Pad code to 6 digits for lookup
    const paddedCode = code.padEnd(6, '0').slice(0, 6);
    const apiType = type === 'Barang' ? 'BARANG' : 'JASA';

    // Debounce API call
    hsCodeDebounceTimers.current[index] = setTimeout(async () => {
      try {
        const response = await fetch(`/api/hs-codes/${paddedCode}?type=${apiType}`);

        if (!response.ok) {
          // HS code not found
          setHsCodeValidations(prev => ({
            ...prev,
            [index]: {
              isValid: false,
              warning: `HS Code "${code}" not found in database`
            }
          }));
          return;
        }

        const data = await response.json();

        // Check if type matches
        if (data.record.type !== apiType) {
          setHsCodeValidations(prev => ({
            ...prev,
            [index]: {
              isValid: false,
              warning: `HS Code type mismatch: Expected ${type}, but code is for ${data.record.type === 'BARANG' ? 'Barang' : 'Jasa'}`,
              data: {
                code: data.record.code,
                type: data.record.type,
                descriptionId: data.record.descriptionId,
                descriptionEn: data.record.descriptionEn,
                level: data.record.level
              }
            }
          }));
          return;
        }

        // Valid HS code
        setHsCodeValidations(prev => ({
          ...prev,
          [index]: {
            isValid: true,
            data: {
              code: data.record.code,
              type: data.record.type,
              descriptionId: data.record.descriptionId,
              descriptionEn: data.record.descriptionEn,
              level: data.record.level
            }
          }
        }));
      } catch (error) {
        console.error('Failed to validate HS code:', error);
        setHsCodeValidations(prev => ({
          ...prev,
          [index]: {
            isValid: false,
            warning: 'Failed to validate HS code'
          }
        }));
      }
    }, 500); // 500ms debounce
  }, []);

  const handleHsCodeMouseEnter = (index: number) => {
    // Don't show tooltip if dropdown is active
    if (focusedHsCodeIndex === index) {
      return;
    }

    // Clear any pending hide timeout
    if (hsCodeHideTimeout.current) {
      clearTimeout(hsCodeHideTimeout.current);
      hsCodeHideTimeout.current = null;
    }

    const validation = hsCodeValidations[index];
    if (!validation?.data) {
      return;
    }

    const container = hsCodeFieldRefs.current[index];
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

    setHoveredHsCode({ index, position: preferTop ? 'top' : 'bottom' });
  };

  const handleHsCodeMouseLeave = () => {
    // Add a delay to allow mouse to move to tooltip
    hsCodeHideTimeout.current = setTimeout(() => {
      setHoveredHsCode(null);
    }, 200);
  };

  const handleHsCodeTooltipMouseEnter = (index: number) => {
    // Clear any pending hide timeout when entering tooltip
    if (hsCodeHideTimeout.current) {
      clearTimeout(hsCodeHideTimeout.current);
      hsCodeHideTimeout.current = null;
    }
  };

  const handleHsCodeTooltipMouseLeave = () => {
    // Hide immediately when leaving tooltip
    setHoveredHsCode(null);
  };

  // HS Code search function
  const searchHsCodes = useCallback(async (index: number, query: string, type: 'Barang' | 'Jasa') => {
    // Clear existing timer
    if (hsCodeSearchTimers.current[index]) {
      clearTimeout(hsCodeSearchTimers.current[index]);
    }

    // Clear suggestions if query is empty
    if (!query || query.trim().length === 0) {
      setHsCodeSuggestions(prev => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      setHsCodeSearchLoading(prev => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      return;
    }

    const trimmedQuery = query.trim();

    // Don't search if query is too short (less than 2 characters)
    if (trimmedQuery.length < 2) {
      return;
    }

    const apiType = type === 'Barang' ? 'BARANG' : 'JASA';

    // Set loading state
    setHsCodeSearchLoading(prev => ({ ...prev, [index]: true }));

    // Debounce the search
    hsCodeSearchTimers.current[index] = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        params.set('search', trimmedQuery);
        params.set('type', apiType);
        params.set('limit', '10'); // Limit to 10 suggestions

        const response = await fetch(`/api/hs-codes?${params.toString()}`);

        if (!response.ok) {
          throw new Error('Failed to search HS codes');
        }

        const data = await response.json();
        const suggestions: HsCodeSuggestion[] = (data.items || []).map((item: any) => ({
          id: item.id,
          code: item.code,
          type: item.type,
          level: item.level,
          descriptionEn: item.descriptionEn,
          descriptionId: item.descriptionId
        }));

        setHsCodeSuggestions(prev => ({ ...prev, [index]: suggestions }));
        setSelectedSuggestionIndex(prev => ({ ...prev, [index]: -1 }));
      } catch (error) {
        console.error('Failed to search HS codes:', error);
        setHsCodeSuggestions(prev => {
          const next = { ...prev };
          delete next[index];
          return next;
        });
      } finally {
        setHsCodeSearchLoading(prev => {
          const next = { ...prev };
          delete next[index];
          return next;
        });
      }
    }, 300); // 300ms debounce
  }, []);

  const selectHsCodeSuggestion = useCallback((index: number, suggestion: HsCodeSuggestion) => {
    updateItem(index, 'hs_code', suggestion.code);
    setHsCodeSuggestions(prev => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    setFocusedHsCodeIndex(null);
    setSelectedSuggestionIndex(prev => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }, []);

  const handleHsCodeKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    const suggestions = hsCodeSuggestions[index] || [];
    const currentSelectedIndex = selectedSuggestionIndex[index] ?? -1;

    if (suggestions.length === 0) {
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        const nextIndex = currentSelectedIndex < suggestions.length - 1 ? currentSelectedIndex + 1 : 0;
        setSelectedSuggestionIndex(prev => ({ ...prev, [index]: nextIndex }));
        break;
      case 'ArrowUp':
        e.preventDefault();
        const prevIndex = currentSelectedIndex > 0 ? currentSelectedIndex - 1 : suggestions.length - 1;
        setSelectedSuggestionIndex(prev => ({ ...prev, [index]: prevIndex }));
        break;
      case 'Enter':
        e.preventDefault();
        if (currentSelectedIndex >= 0 && currentSelectedIndex < suggestions.length) {
          selectHsCodeSuggestion(index, suggestions[currentSelectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setHsCodeSuggestions(prev => {
          const next = { ...prev };
          delete next[index];
          return next;
        });
        setFocusedHsCodeIndex(null);
        break;
    }
  }, [hsCodeSuggestions, selectedSuggestionIndex, selectHsCodeSuggestion]);

  useEffect(() => {
    descriptionFieldRefs.current = descriptionFieldRefs.current.slice(0, items.length);
    descriptionInputRefs.current = descriptionInputRefs.current.slice(0, items.length);
    hsCodeFieldRefs.current = hsCodeFieldRefs.current.slice(0, items.length);
    hsCodeInputRefs.current = hsCodeInputRefs.current.slice(0, items.length);
    hsCodeDropdownRefs.current = hsCodeDropdownRefs.current.slice(0, items.length);
    setFocusedDescriptionIndex(current => (current !== null && current >= items.length ? null : current));
    setHoveredDescription(current => (current && current.index >= items.length ? null : current));
    setHoveredHsCode(current => (current && current.index >= items.length ? null : current));
    setFocusedHsCodeIndex(current => (current !== null && current >= items.length ? null : current));
  }, [items.length]);

  // Click outside handler for HS Code dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (focusedHsCodeIndex === null) return;

      const target = event.target as Node;
      const inputRef = hsCodeInputRefs.current[focusedHsCodeIndex];
      const dropdownRef = hsCodeDropdownRefs.current[focusedHsCodeIndex];

      if (
        inputRef && !inputRef.contains(target) &&
        dropdownRef && !dropdownRef.contains(target)
      ) {
        setFocusedHsCodeIndex(null);
        setHsCodeSuggestions(prev => {
          const next = { ...prev };
          delete next[focusedHsCodeIndex];
          return next;
        });
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [focusedHsCodeIndex]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (hsCodeHideTimeout.current) {
        clearTimeout(hsCodeHideTimeout.current);
      }
    };
  }, []);

  // Initialize HS code memory and trigger validation on initial load
  useEffect(() => {
    items.forEach((item, index) => {
      // Initialize memory for this item if not exists
      if (!hsCodeMemory.current[index]) {
        hsCodeMemory.current[index] = { barang: null, jasa: null };
      }

      // Store the initial HS code in the appropriate type slot
      if (item.hs_code && item.hs_code.trim() !== '') {
        if (item.type === 'Barang') {
          hsCodeMemory.current[index].barang = item.hs_code;
        } else {
          hsCodeMemory.current[index].jasa = item.hs_code;
        }
      }

      // Validate the code
      if (item.hs_code && item.type) {
        validateHsCode(index, item.hs_code, item.type);
      }
    });
  }, [items, validateHsCode]);

  const handleDescriptionMouseEnter = (index: number) => {
    if (focusedDescriptionIndex === index) {
      return;
    }

    recomputeDescriptionTruncation();

    if (!isDescriptionTextTruncated(index)) {
      setHoveredDescription(null);
      return;
    }
    const container = descriptionFieldRefs.current[index];
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
    setHoveredDescription({ index, position: preferTop ? 'top' : 'bottom' });
  };

  const handleDescriptionMouseLeave = () => {
    setHoveredDescription(null);
  };

  const [trxCode, setTrxCode] = useState<string | null>(null);
  const [trxCodeRequired, setTrxCodeRequired] = useState(false);

  useEffect(() => {
    if (!jobId) return;

    const fetchData = async () => {
      try {
        const [invoiceResponse, uomResponse, partiesResponse, trxCodesResponse] = await Promise.all([
          fetch(`/api/review/${jobId}`),
          fetch('/api/uom'),
          fetch('/api/parties?limit=1000'), // Fetch all parties for override capability
          fetch('/api/transaction-codes')
        ]);

        if (!invoiceResponse.ok) {
          const errorData = await invoiceResponse.json().catch(() => null);
          const errorMessage = errorData?.error?.message || `Failed to load invoice data (${invoiceResponse.status})`;
          throw new Error(errorMessage);
        }

        const invoiceData = await invoiceResponse.json();
        const uoms = uomResponse.ok ? await uomResponse.json() : [];
        const trxCodesRaw = trxCodesResponse.ok ? await trxCodesResponse.json() : [];
        const normalizedTrxCodes: TransactionCode[] = (trxCodesRaw || []).map((code: any) => ({
          code: code.code,
          name: code.name,
          description: code.description ?? ''
        }));

        // Use buyer_candidates from API response (already sorted by score with real fuzzy scores)
        // API now computes real scores for ALL scenarios (auto, locked, pending_confirmation, pending_selection)
        const partiesToUse = invoiceData.buyer_candidates || [];

        // Auto-select top candidate for pending_confirmation and pending_selection
        let initialBuyerSelection: string | null = null;
        let initialBuyerCandidateTrxCode: string | null = null;
        if (invoiceData.buyer_resolution_status === 'pending_confirmation' ||
            invoiceData.buyer_resolution_status === 'pending_selection') {
          if (partiesToUse.length > 0) {
            const topCandidate = partiesToUse[0];
            initialBuyerSelection = topCandidate.id;
            initialBuyerCandidateTrxCode = topCandidate.transactionCode ?? null;
          }
        }

        const normalizeTrxPrefill = (value: string | null | undefined) => {
          if (typeof value !== 'string') {
            return null;
          }
          const trimmed = value.trim();
          return trimmed.length > 0 ? trimmed : null;
        };

        const initialTrx =
          normalizeTrxPrefill(invoiceData.trx_code) ??
          normalizeTrxPrefill(invoiceData.buyer_resolved?.transactionCode) ??
          normalizeTrxPrefill(initialBuyerCandidateTrxCode);

        const normalizedItems = (invoiceData.items || []).map((item: LineItemBase, index: number) =>
          createLineItemState(item, index)
        );

        orderKeyRef.current = normalizedItems.length;

        setInvoiceData(invoiceData);
        setInvoiceDate(invoiceData.invoice_date);
        setInvoiceNo(invoiceData.invoice_number);
        setItems(normalizedItems);
        setUomList(uoms);
        setAllParties(partiesToUse);
        setTransactionCodes(normalizedTrxCodes);
        setTrxCode(initialTrx);
        setTrxCodeRequired(Boolean(invoiceData.trx_code_required));
        setSelectedBuyerPartyId(initialBuyerSelection);

        // Save initial snapshot for dirty tracking
        setInitialSnapshot({
          invoiceDate: invoiceData.invoice_date,
          invoiceNo: invoiceData.invoice_number,
          items: normalizedItems.map(createStoredState),
          trxCode: initialTrx
        });
      } catch (err) {
        console.error('Failed to load invoice:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [jobId]);

  const validateItem = (item: LineItem, index: number): ItemErrors => {
    const errors: ItemErrors = {};

    if (!item.description || item.description.trim() === '') {
      errors.description = 'Description is required';
    }

    if (item.qty === null || item.qty === undefined || isNaN(item.qty) || item.qty < 0) {
      errors.qty = 'Quantity must be ≥ 0';
    }

    if (item.unit_price === null || item.unit_price === undefined || isNaN(item.unit_price) || item.unit_price < 0) {
      errors.unit_price = 'Unit price must be ≥ 0';
    }

    // HS Code is required for both Barang and Jasa
    if (!item.hs_code || !/^\d+$/.test(item.hs_code)) {
      errors.hs_code = 'HS Code must be digits only';
    }

    if (!item.uom || item.uom.trim() === '') {
      errors.uom = 'UOM is required';
    }

    if (!item.type || (item.type !== 'Barang' && item.type !== 'Jasa')) {
      errors.type = 'Type is required';
    }

    return errors;
  };

  // Validate all items on initial load
  useEffect(() => {
    if (!initialSnapshot || items.length === 0) return;

    setErrors(buildErrors(items, validateItem));
  }, [initialSnapshot, items]);

  // Auto-reset "Apply to All" state after 2 seconds
  useEffect(() => {
    if (applyToAllState) {
      const timer = setTimeout(() => {
        setApplyToAllState(null);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [applyToAllState]);

  // Auto-reset "Apply to All UOM" state after 2 seconds
  useEffect(() => {
    if (applyToAllUom) {
      const timer = setTimeout(() => {
        setApplyToAllUom(null);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [applyToAllUom]);

  useEffect(() => {
    setSelectedIds(prev => {
      const existingIds = new Set(items.map(item => item.id));
      let mutated = false;
      const next = new Set<string>();
      prev.forEach(id => {
        if (existingIds.has(id)) {
          next.add(id);
        } else {
          mutated = true;
        }
      });

      if (!mutated) {
        return prev;
      }

      return next;
    });
  }, [items]);

  const updateItem = (index: number, field: keyof LineItem, value: any) => {
    setItems(prev => {
      const updated = [...prev];
      const nextItem = { ...updated[index], [field]: value } as LineItem;

      if (field === 'taxRate') {
        const numeric = typeof value === 'number' && !Number.isNaN(value)
          ? value
          : parseFloat(String(value)) || 0;
        nextItem.taxRate = numeric;
      }

      if (field === 'qty' || field === 'unit_price') {
        const qty = field === 'qty' ? value : nextItem.qty;
        const unitPrice = field === 'unit_price' ? value : nextItem.unit_price;
        nextItem.amount = qty * unitPrice;
        nextItem.roundingAdjustment = undefined;
      }

      // If type switches to Jasa, only set UOM to default Jasa UOM (if present)
      if (field === 'type' && value === 'Jasa') {
        const jasaUomAvailable = uomList.some(u => u.code === JASA_UOM_CODE);
        nextItem.uom = jasaUomAvailable ? JASA_UOM_CODE : (nextItem.uom || '');
      }

      updated[index] = nextItem;
      return updated;
    });

    // Validate on change
    const newItem = { ...items[index], [field]: value } as LineItem;

    if (field === 'taxRate') {
      const numeric = typeof value === 'number' && !Number.isNaN(value)
        ? value
        : parseFloat(String(value)) || 0;
      newItem.taxRate = numeric;
    }

    // Mirror the side effects for validation preview object
    if (field === 'type' && value === 'Jasa') {
      const jasaUomAvailable = uomList.some(u => u.code === JASA_UOM_CODE);
      newItem.uom = jasaUomAvailable ? JASA_UOM_CODE : (newItem.uom || '');
    }

    if (field === 'qty' || field === 'unit_price') {
      const qty = field === 'qty' ? value : newItem.qty;
      const unitPrice = field === 'unit_price' ? value : newItem.unit_price;
      newItem.amount = qty * unitPrice;
      newItem.roundingAdjustment = undefined;
    }

    const itemErrors = validateItem(newItem, index);
    setErrors(prev => ({
      ...prev,
      [index]: itemErrors
    }));

    // Trigger HS code validation when hs_code or type changes
    if (field === 'hs_code' || field === 'type') {
      const hsCode = field === 'hs_code' ? value : newItem.hs_code;
      const itemType = field === 'type' ? value : newItem.type;
      if (hsCode && itemType) {
        validateHsCode(index, hsCode, itemType);
      }
    }
  };

  const checkHsCodeValidForType = useCallback(async (code: string, type: 'Barang' | 'Jasa'): Promise<boolean> => {
    if (!code || code.trim() === '') return false;

    const paddedCode = code.padEnd(6, '0').slice(0, 6);
    const apiType = type === 'Barang' ? 'BARANG' : 'JASA';

    try {
      const response = await fetch(`/api/hs-codes/${paddedCode}?type=${apiType}`);
      return response.ok;
    } catch (error) {
      return false;
    }
  }, []);

  const handleTypeSelect = async (index: number, type: 'Barang' | 'Jasa') => {
    const currentItem = items[index];
    const currentType = currentItem.type;
    const currentHsCode = currentItem.hs_code;

    // Initialize memory for this item if not exists
    if (!hsCodeMemory.current[index]) {
      hsCodeMemory.current[index] = { barang: null, jasa: null };
    }

    // Save current HS code to memory for the current type
    if (currentHsCode && currentHsCode.trim() !== '') {
      if (currentType === 'Barang') {
        hsCodeMemory.current[index].barang = currentHsCode;
      } else {
        hsCodeMemory.current[index].jasa = currentHsCode;
      }
    }

    // Check if current HS code is valid for the new type
    let newHsCode = currentHsCode;

    if (currentHsCode && currentHsCode.trim() !== '') {
      const isValid = await checkHsCodeValidForType(currentHsCode, type);

      if (!isValid) {
        // Code not valid for new type, check if we have a saved code for this type
        const savedCode = type === 'Barang'
          ? hsCodeMemory.current[index].barang
          : hsCodeMemory.current[index].jasa;

        newHsCode = savedCode || '';
      }
    } else {
      // No current code, try to restore from memory
      const savedCode = type === 'Barang'
        ? hsCodeMemory.current[index].barang
        : hsCodeMemory.current[index].jasa;

      newHsCode = savedCode || '';
    }

    // Update the item with new type and potentially new HS code
    setItems(prev => {
      const updated = [...prev];
      const nextItem = { ...updated[index] };

      nextItem.type = type;
      nextItem.hs_code = newHsCode;

      // If type switches to Jasa, set UOM to default Jasa UOM (if present)
      if (type === 'Jasa') {
        const jasaUomAvailable = uomList.some(u => u.code === JASA_UOM_CODE);
        nextItem.uom = jasaUomAvailable ? JASA_UOM_CODE : (nextItem.uom || '');
      }

      updated[index] = nextItem;
      return updated;
    });

    // Validate the new item
    const newItem = { ...currentItem, type, hs_code: newHsCode };
    if (type === 'Jasa') {
      const jasaUomAvailable = uomList.some(u => u.code === JASA_UOM_CODE);
      newItem.uom = jasaUomAvailable ? JASA_UOM_CODE : (newItem.uom || '');
    }

    const itemErrors = validateItem(newItem as LineItem, index);
    setErrors(prev => ({
      ...prev,
      [index]: itemErrors
    }));

    // Trigger validation for the new HS code if it exists
    if (newHsCode && newHsCode.trim() !== '') {
      validateHsCode(index, newHsCode, type);
    } else {
      // Clear validation if no code
      setHsCodeValidations(prev => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
    }

    // Show "Apply to All" only if multiple items exist
    if (items.length > 1) {
      setApplyToAllState({ itemIndex: index, type });
    }
  };

  const handleApplyToAll = (type: 'Barang' | 'Jasa') => {
    setItems(prev => prev.map(item => {
      if (type === 'Jasa') {
        const jasaUomAvailable = uomList.some(u => u.code === JASA_UOM_CODE);
        return {
          ...item,
          type: 'Jasa',
          uom: jasaUomAvailable ? JASA_UOM_CODE : (item.uom || '')
        };
      }
      // Barang: only change type; keep other fields as-is
      return { ...item, type: 'Barang' };
    }));

    setApplyToAllState(null);
  };

  const handleApplyUomToAll = (uomCode: string) => {
    // Apply the UOM to all items
    setItems(prev => prev.map(item => ({ ...item, uom: uomCode })));

    // Clear the "Apply to All UOM" state immediately
    setApplyToAllUom(null);
  };

  const handleUomSelect = (index: number, uomCode: string) => {
    // Respect explicit user choice even if current type is Jasa
    updateItem(index, 'uom', uomCode);

    // Offer "Apply to All" for UOM for 2s (you already have the reset effect)
    if (items.length > 1) {
      setApplyToAllUom({ itemIndex: index, uomCode });
    }
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  const toggleSelection = (id: string, checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const handleAddItem = () => {
    const orderKey = orderKeyRef.current;
    orderKeyRef.current += 1;

    const baseItem: LineItemBase = {
      description: '',
      qty: 1,
      unit_price: 0,
      amount: 0,
      sku: null,
      hs_code: '',
      uom: '',
      type: 'Barang',
      taxRate: 12
    };

    const newItem = createLineItemState(baseItem, orderKey);

    setItems(prev => {
      const updated = [...prev, newItem];
      setErrors(buildErrors(updated, validateItem));
      return updated;
    });

    setApplyToAllState(null);
    setApplyToAllUom(null);
  };

  const handleDeleteItem = (id: string) => {
    const target = items.find(item => item.id === id);
    if (!target) return;

    const confirmed = window.confirm('Delete this line item? This action cannot be undone.');
    if (!confirmed) return;

    setItems(prev => {
      const updated = prev.filter(item => item.id !== id);
      setErrors(buildErrors(updated, validateItem));
      return updated;
    });

    setSelectedIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

    setApplyToAllState(null);
    setApplyToAllUom(null);
  };

  const handleMerge = (anchorId: string) => {
    const selectedArray = Array.from(selectedIds).filter(id => items.some(item => item.id === id));
    if (selectedArray.length < 2 || !selectedArray.includes(anchorId)) {
      return;
    }

    setItems(prev => {
      const anchorIndex = prev.findIndex(item => item.id === anchorId);
      if (anchorIndex === -1) return prev;

      const anchorItem = prev[anchorIndex];
      if (anchorItem.qty <= 0) {
        return prev;
      }

      const selectedItems = selectedArray
        .map(id => prev.find(item => item.id === id))
        .filter((item): item is LineItem => Boolean(item));

      if (selectedItems.length < 2) return prev;

      const otherIds = selectedArray.filter(id => id !== anchorId);

      const totalAmount = selectedItems.reduce((sum, current) => sum + current.amount, 0);
      // Capture the original anchor so unmerge can restore the exact values and position.
      const anchorOriginal = anchorItem.mergeSnapshot
        ? cloneStoredState(anchorItem.mergeSnapshot.anchor)
        : createStoredState(anchorItem);

      const existingComponents = anchorItem.mergeSnapshot
        ? anchorItem.mergeSnapshot.components.map(component => cloneStoredState(component))
        : [];

      const newComponents: StoredItemState[] = [];
      otherIds.forEach(id => {
        const found = prev.find(item => item.id === id);
        if (!found) return;
        flattenStoredItems(found).forEach(snapshot => {
          newComponents.push(cloneStoredState(snapshot));
        });
      });

      const combinedComponents = [...existingComponents, ...newComponents]
        .map(component => cloneStoredState(component))
        .sort((a, b) => a.orderKey - b.orderKey);

      const anchorQty = anchorItem.qty;
      if (anchorQty <= 0) {
        return prev;
      }

      // Anchor-preserving math: keep anchor qty and attributes, only recompute price/amount.
      const recalculatedUnitPrice = Math.round(totalAmount / anchorQty);
      const roundingAdjustment = totalAmount - recalculatedUnitPrice * anchorQty;

      const mergeId = generateItemId();

      const updatedAnchor: LineItem = {
        ...anchorItem,
        amount: totalAmount,
        unit_price: recalculatedUnitPrice,
        mergeSnapshot: {
          mergeId,
          anchor: anchorOriginal,
          components: combinedComponents,
          totalAmount,
          roundingAdjustment: roundingAdjustment !== 0 ? roundingAdjustment : undefined
        },
        roundingAdjustment: roundingAdjustment !== 0 ? roundingAdjustment : undefined
      };

      const filtered = prev.filter(item => !otherIds.includes(item.id));
      const replacementIndex = filtered.findIndex(item => item.id === anchorId);
      if (replacementIndex === -1) return prev;

      filtered[replacementIndex] = updatedAnchor;
      setErrors(buildErrors(filtered, validateItem));
      return filtered;
    });

    clearSelection();
    setApplyToAllState(null);
    setApplyToAllUom(null);
  };

  const handleUnmerge = (anchorId: string) => {
    setItems(prev => {
      const anchorIndex = prev.findIndex(item => item.id === anchorId);
      if (anchorIndex === -1) return prev;

      const anchorItem = prev[anchorIndex];
      if (!anchorItem.mergeSnapshot) return prev;

      const restoredItems = [anchorItem.mergeSnapshot.anchor, ...anchorItem.mergeSnapshot.components]
        .map(component => restoreFromStored(component));

      const remaining = prev.filter(item => item.id !== anchorId);
      const combined = [...remaining, ...restoredItems].sort((a, b) => a.orderKey - b.orderKey);

      setErrors(buildErrors(combined, validateItem));
      return combined;
    });

    clearSelection();
    setApplyToAllState(null);
    setApplyToAllUom(null);
  };

  // Dirty tracking
  const isDirty = useMemo(() => {
    if (!initialSnapshot) return false;

    if (invoiceDate !== initialSnapshot.invoiceDate) return true;

    if (invoiceNo !== initialSnapshot.invoiceNo) return true;

    if (initialSnapshot.trxCode !== trxCode) return true;

    if (items.length !== initialSnapshot.items.length) return true;

    for (let i = 0; i < items.length; i++) {
      const current = items[i];
      const initial = initialSnapshot.items[i];

      if (
        current.description !== initial.description ||
        current.qty !== initial.qty ||
        current.unit_price !== initial.unit_price ||
        current.sku !== initial.sku ||
        current.hs_code !== initial.hs_code ||
        current.uom !== initial.uom ||
        current.type !== initial.type ||
        current.taxRate !== initial.taxRate
      ) {
        return true;
      }
    }

    return false;
  }, [invoiceDate, invoiceNo, items, initialSnapshot, trxCode]);

  // Check if there are any validation errors
  const hasErrors = useMemo(() => {
    return Object.values(errors).some(itemErrors => Object.keys(itemErrors).length > 0);
  }, [errors]);

  // Check if there are any HS code validation warnings
  const hasHsCodeWarnings = useMemo(() => {
    return items.some((item, index) => {
      // HS Code is required for both Barang and Jasa
      // Empty or invalid format
      if (!item.hs_code || !/^\d+$/.test(item.hs_code)) {
        return true;
      }
      // Has validation warning from API
      if (hsCodeValidations[index]?.warning) {
        return true;
      }
      return false;
    });
  }, [items, hsCodeValidations]);

  // Check if buyer is unresolved
  const buyerUnresolved = useMemo(() => {
    if (!invoiceData) return false;
    return invoiceData.buyer_unresolved && !selectedBuyerPartyId;
  }, [invoiceData, selectedBuyerPartyId]);

  // Check if buyer selection has changed
  const buyerSelectionChanged = useMemo(() => {
    if (!invoiceData) return false;
    // If buyer was unresolved and user selected one
    if (invoiceData.buyer_unresolved && selectedBuyerPartyId) return true;
    // If buyer was resolved and user changed it
    if (invoiceData.buyer_resolved && selectedBuyerPartyId &&
        invoiceData.buyer_resolved.id !== selectedBuyerPartyId) return true;
    return false;
  }, [invoiceData, selectedBuyerPartyId]);

  const selectedCount = useMemo(() => {
    if (selectedIds.size === 0) return 0;
    const ids = selectedIds;
    return items.reduce((count, item) => (ids.has(item.id) ? count + 1 : count), 0);
  }, [items, selectedIds]);

  const canMergeSelection = selectedCount >= 2;

  const trxCodeErrorMessage = trxCodeRequired && !trxCode
    ? 'Transaction code is required before saving XML.'
    : null;

  const saveDisabled = useMemo(() => {
    if (trxCodeRequired && !trxCode) {
      return true;
    }

    return (!isDirty && !buyerSelectionChanged) || hasErrors || buyerUnresolved || hasHsCodeWarnings;
  }, [trxCodeRequired, trxCode, isDirty, buyerSelectionChanged, hasErrors, buyerUnresolved, hasHsCodeWarnings]);

  const handleCancel = () => {
    router.push('/queue');
  };

  const handleSave = async () => {
    setSaveError(null); // Clear any previous save errors

    if (trxCodeRequired && !trxCode) {
      return;
    }

    try {
      const response = await fetch(`/api/review/${jobId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          invoice_number: invoiceNo,
          invoice_date: invoiceDate,
          items: items.map(item => ({
            description: item.description,
            qty: item.qty,
            unit_price: item.unit_price,
            amount: item.amount,
            sku: item.sku,
            hs_code: item.hs_code,
            uom: item.uom,
            type: item.type
          })),
          buyer_party_id: selectedBuyerPartyId,
          trx_code: trxCode
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        const errorMessage = errorData?.error?.message || 'Failed to save XML';
        throw new Error(errorMessage);
      }

      // Success - redirect to queue with success message
      router.push('/queue?saved=true');
    } catch (err) {
      console.error('Save error:', err);
      setSaveError(err instanceof Error ? err.message : 'Failed to save XML');
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(value);
  };

  const totalAmount = items.reduce((sum, item) => sum + item.amount, 0);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-600">Loading invoice data...</div>
      </div>
    );
  }

  if (error || !invoiceData) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-lg border border-red-200 p-8 max-w-md">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
              <svg className="w-6 h-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-gray-900">Failed to Load Invoice</h2>
          </div>
          <p className="text-sm text-gray-600 mb-4">
            {error || 'No data found'}
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => router.push('/queue')}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Back to Queue
            </button>
            <button
              onClick={() => window.location.reload()}
              className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 bg-white border-b shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-3">
          {/* Row 1 - Title, Invoice Number, Invoice Date, Actions */}
          <div className="flex items-center justify-between gap-4 mb-3">
            <div className="flex items-center gap-3">
              <h1 className="text-base font-semibold text-gray-900 whitespace-nowrap">
                Review Invoice
              </h1>
              <input
                type="text"
                value={invoiceNo}
                onChange={(e) => setInvoiceNo(e.target.value)}
                className="px-2.5 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Invoice Number"
              />
              <input
                id="invoice-date"
                type="date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
                className="px-2.5 py-1.5 text-xs border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleCancel}
                className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saveDisabled}
                className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                Save XML
              </button>
            </div>
          </div>

          {/* Row 2 - Seller, Buyer Dropdown, Transaction Code, Total */}
          <div className="flex items-start gap-3 pt-2 border-t">
            <div className="flex items-center gap-2 flex-shrink-0 pt-6">
              <a
                href="/admin/parties"
                className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                {invoiceData.seller_name}
              </a>
              <span className="text-gray-400">→</span>
            </div>

            <div className="flex-1 min-w-0 grid grid-cols-12 gap-3">
              {/* Buyer Dropdown - 6 columns */}
              <div className="col-span-6">
                <label className="block text-xs font-medium text-gray-700 mb-1.5">
                  <a
                    href="/admin/parties"
                    className="text-blue-600 hover:text-blue-800 hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Buyer Information
                  </a>
                </label>
                {/* Auto-matched or Locked */}
                {(invoiceData.buyer_resolution_status === 'auto' || invoiceData.buyer_resolution_status === 'locked') && invoiceData.buyer_resolved && (
                  <BuyerDropdown
                    candidates={allParties}
                    selectedId={selectedBuyerPartyId || invoiceData.buyer_resolved.id}
                    onChange={(id) => setSelectedBuyerPartyId(id)}
                    prefilledParty={invoiceData.buyer_resolved}
                    prefilledConfidence={invoiceData.buyer_resolution_confidence ?? null}
                    highlightThreshold={0.90}
                  />
                )}

                {/* Pending Confirmation */}
                {invoiceData.buyer_resolution_status === 'pending_confirmation' && (
                  <BuyerDropdown
                    candidates={allParties}
                    selectedId={selectedBuyerPartyId}
                    onChange={(id) => setSelectedBuyerPartyId(id)}
                    highlightThreshold={0.86}
                  />
                )}

                {/* Pending Selection */}
                {invoiceData.buyer_resolution_status === 'pending_selection' && (
                  <BuyerDropdown
                    candidates={allParties}
                    selectedId={selectedBuyerPartyId}
                    onChange={(id) => setSelectedBuyerPartyId(id)}
                  />
                )}

                {buyerUnresolved && (
                  <p className="mt-0.5 text-xs text-red-600">
                    ⚠ Select buyer before saving
                  </p>
                )}
              </div>

              {/* Transaction Code - 6 columns */}
              <div className="col-span-6">
                <label className="block text-xs font-medium text-gray-700 mb-1.5">
                  Transaction Code
                  {trxCodeRequired && <span className="text-red-500 ml-1">*</span>}
                </label>
                <TransactionCodeDropdown
                  codes={transactionCodes}
                  selectedCode={trxCode}
                  onChange={(code) => {
                    setTrxCode(code);
                    setSaveError(null);
                  }}
                  required={trxCodeRequired}
                  error={trxCodeErrorMessage}
                  compact={true}
                />
              </div>
            </div>

            <div className="flex items-center gap-2 ml-4 flex-shrink-0">
              <span className="text-xs font-medium text-gray-600 whitespace-nowrap">Total</span>
              <span className="text-sm font-bold text-gray-900 whitespace-nowrap">{formatCurrency(totalAmount)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6">
        {/* Save Error Banner */}
        {saveError && (
          <div className="mb-4 bg-red-50 border border-red-200 rounded-md p-3">
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-2">
                <svg className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="flex-1">
                  <h3 className="text-xs font-medium text-red-800">Failed to save XML</h3>
                  <p className="mt-0.5 text-xs text-red-700">{saveError}</p>
                </div>
              </div>
              <button
                onClick={() => setSaveError(null)}
                className="flex-shrink-0 ml-2 text-red-400 hover:text-red-600 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* Line Items Header */}
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-medium text-gray-700">
              Line Items <span className="text-gray-500 font-normal">({items.length})</span>
            </h2>
            {selectedCount > 0 && (
              <div className="flex items-center gap-2 text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded-full">
                <span>Selected: {selectedCount}</span>
                <button
                  type="button"
                  onClick={clearSelection}
                  className="text-blue-600 hover:text-blue-700"
                >
                  Clear selection
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleAddItem}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <span aria-hidden="true">+</span>
            <span>Add Item</span>
          </button>
        </div>

        {/* Line Items */}
        <div className="space-y-2 mb-6">
          {items.map((item, index) => {
            const itemErrors = errors[index] || {};
            const hasItemErrors = Object.keys(itemErrors).length > 0;
            const isSelected = selectedIds.has(item.id);
            const showMergeHere = canMergeSelection && isSelected;
            const mergeDisabled = item.qty <= 0;
            const componentCount = item.mergeSnapshot ? item.mergeSnapshot.components.length + 1 : 0;
            const componentTooltip = item.mergeSnapshot
              ? [item.mergeSnapshot.anchor, ...item.mergeSnapshot.components]
                  .map(component => {
                    const descriptor = component.description && component.description.trim() !== ''
                      ? component.description.trim()
                      : 'No description';
                    return `${descriptor} - Qty ${component.qty} - ${formatCurrency(component.amount)}`;
                  })
                  .join('\n')
              : '';
            const hasRoundingNote = typeof item.roundingAdjustment === 'number' && item.roundingAdjustment !== 0;
            const mergeButtonTitle = mergeDisabled
              ? 'Set qty > 0 to merge here.'
              : `Merge ${selectedCount} selected items into this line.`;
            const qtyValue = Number.isFinite(item.qty) ? item.qty : 0;
            const unitPriceValue = Number.isFinite(item.unit_price) ? item.unit_price : 0;
            const lineTotal = Number.isFinite(item.amount) ? item.amount : qtyValue * unitPriceValue;
            const taxRateValue = Number.isFinite(item.taxRate) ? item.taxRate : 12;
            const taxBase = lineTotal * (11 / 12);
            const taxAmount = taxBase * (taxRateValue / 100);
            const showApplyToAllType = items.length > 1 && applyToAllState?.itemIndex === index;
            const applyToAllType = applyToAllState?.type;
            const showApplyToAllUom = items.length > 1 && applyToAllUom?.itemIndex === index;
            const isDescriptionFocused = focusedDescriptionIndex === index;
            const isDescriptionTruncated = isDescriptionTextTruncated(index);
            const showDescriptionTooltip = hoveredDescription?.index === index && !isDescriptionFocused && isDescriptionTruncated;
            const activeTooltipPosition = hoveredDescription?.position ?? 'bottom';
            const cardClassList = [
              'relative rounded-md border transition-colors',
              'bg-white odd:bg-gray-50',
              hasItemErrors
                ? 'border-red-300'
                : 'border-gray-200 hover:border-blue-200 hover:bg-blue-50/50 focus-within:border-blue-200'
            ];

            if (isDescriptionFocused) {
              cardClassList.push('ring-2 ring-blue-300 shadow-lg');
            } else if (isSelected) {
              cardClassList.push('ring-2 ring-blue-200');
            }

            const cardClasses = cardClassList.join(' ');

            return (
              <div key={item.id} className={cardClasses}>
                {isDescriptionFocused && (
                  <div className="pointer-events-none absolute inset-0 z-20 rounded-md bg-slate-100/70 backdrop-blur-sm transition-opacity duration-200" />
                )}
                <div className="relative">
                  <div className="absolute left-2 top-2 flex items-center gap-1 text-[11px] text-gray-500">
                    <input
                      id={`select-${item.id}`}
                      type="checkbox"
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      checked={isSelected}
                      onChange={(e) => toggleSelection(item.id, e.target.checked)}
                      aria-label={`Select line item ${index + 1}`}
                    />
                    <label
                      htmlFor={`select-${item.id}`}
                      className="cursor-pointer select-none font-medium text-gray-500"
                    >
                      #{item.no || index + 1}
                    </label>
                  </div>

                  <div className="flex flex-col gap-2 px-2 py-2 pl-14 text-xs text-gray-700 sm:pl-16 md:text-sm">
                    {(item.mergeSnapshot || hasRoundingNote) && (
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                        {item.mergeSnapshot && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2 py-0.5 font-medium text-purple-700"
                            title={componentTooltip}
                          >
                            Bundle
                            <span>{componentCount} items</span>
                          </span>
                        )}
                        {hasRoundingNote && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700"
                            title="Unit price rounded to keep total amount exact."
                          >
                            Avg price
                          </span>
                        )}
                        {item.mergeSnapshot && (
                          <button
                            type="button"
                            onClick={() => handleUnmerge(item.id)}
                            className="text-[11px] font-medium text-blue-600 hover:text-blue-700 focus:outline-none focus:underline"
                          >
                            Unmerge
                          </button>
                        )}
                      </div>
                    )}

                    <div className="grid grid-cols-[60px_4px_minmax(140px,1fr)_8px_80px_8px_56px_8px_100px_8px_120px_8px_140px_8px_50px_8px_140px_8px_140px_8px_auto] items-start gap-y-2 min-h-[56px]">
                    {/* Type Column */}
                    <div className="flex flex-col gap-1.5 group relative">
                      <div className="flex flex-col gap-1.5 relative">
                        {(() => {
                          const showApplyToAll = showApplyToAllType;
                          return (
                            <>
                              <button
                                onClick={() => {
                                  if (showApplyToAll && applyToAllType === 'Barang') {
                                    handleApplyToAll('Barang');
                                  } else {
                                    handleTypeSelect(index, 'Barang');
                                  }
                                }}
                                className={`w-full rounded-full px-1 py-0.5 text-[11px] font-medium transition-all ${
                                  item.type === 'Barang'
                                    ? 'bg-blue-600 text-white shadow-sm'
                                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                } ${itemErrors.type ? 'ring-1 ring-red-300' : ''}`}
                              >
                                {showApplyToAll && applyToAllType === 'Barang' ? 'All?' : 'Barang'}
                              </button>
                              <button
                                onClick={() => {
                                  if (showApplyToAll && applyToAllType === 'Jasa') {
                                    handleApplyToAll('Jasa');
                                  } else {
                                    handleTypeSelect(index, 'Jasa');
                                  }
                                }}
                                className={`w-full rounded-full px-1 py-0.5 text-[11px] font-medium transition-all ${
                                  item.type === 'Jasa'
                                    ? 'bg-green-600 text-white shadow-sm'
                                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                } ${itemErrors.type ? 'ring-1 ring-red-300' : ''}`}
                              >
                                {showApplyToAll && applyToAllType === 'Jasa' ? 'All?' : 'Jasa'}
                              </button>
                            </>
                          );
                        })()}
                        {itemErrors.type && (
                          <div className="hidden group-hover:block absolute top-full left-0 mt-1 z-50 w-max max-w-[250px] bg-red-50 border border-red-200 rounded px-2 py-1 text-[11px] text-red-700 shadow-md">
                            {itemErrors.type}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Gap between Type and Description (4px) */}
                    <div></div>

                    {/* Description Column */}
                    <div className="flex flex-col gap-1 group relative">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 flex items-center gap-1">
                        Description <span className="text-red-500">*</span>
                        {itemErrors.description && (
                          <span className="text-red-500" title="Error">⚠️</span>
                        )}
                      </span>
                      <div
                        className="relative min-h-[38px]"
                        ref={(el) => {
                          descriptionFieldRefs.current[index] = el;
                        }}
                        onMouseEnter={() => {
                          if (!item.description) {
                            return;
                          }
                          handleDescriptionMouseEnter(index);
                        }}
                        onMouseLeave={handleDescriptionMouseLeave}
                      >
                        <input
                          type="text"
                          value={item.description}
                          onChange={(e) => updateItem(index, 'description', e.target.value)}
                          onFocus={() => {
                            const shouldExpand = isDescriptionTextTruncated(index);
                            setFocusedDescriptionIndex(shouldExpand ? index : null);
                            setHoveredDescription(null);
                          }}
                          onBlur={() => {
                            setFocusedDescriptionIndex(current => (current === index ? null : current));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.stopPropagation();
                              setFocusedDescriptionIndex(null);
                              e.currentTarget.blur();
                            }
                          }}
                          placeholder="Item description"
                          title={isDescriptionTruncated ? item.description : undefined}
                          aria-expanded={isDescriptionFocused}
                          ref={(el) => {
                            descriptionInputRefs.current[index] = el;
                          }}
                          className={[
                            'rounded border px-2 py-1 transition-all duration-200 ease-out focus:outline-none',
                            itemErrors.description
                              ? 'border-red-300 focus:border-red-400 focus:ring-1 focus:ring-red-400'
                              : 'border-gray-300 focus:border-blue-400 focus:ring-1 focus:ring-blue-300',
                            isDescriptionFocused
                              ? 'absolute left-0 top-0 z-40 bg-white shadow-lg focus:ring-2 focus:ring-blue-300'
                              : 'relative w-full truncate h-[34px]'
                          ].join(' ')}
                          style={isDescriptionFocused ? { width: 'min(560px, 95vw)' } : undefined}
                        />
                        {showDescriptionTooltip && (
                          <div
                            className={`absolute ${
                              activeTooltipPosition === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'
                            } z-40 w-max max-w-[360px] rounded-md border border-gray-200 bg-white p-2 text-xs leading-relaxed text-gray-700 shadow-lg`}
                            role="tooltip"
                          >
                            <span className="whitespace-pre-wrap break-words">{item.description}</span>
                          </div>
                        )}
                        {itemErrors.description && (
                          <div className="hidden group-hover:block absolute top-full left-0 mt-1 z-50 w-max max-w-[250px] bg-red-50 border border-red-200 rounded px-2 py-1 text-[11px] text-red-700 shadow-md">
                            {itemErrors.description}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Gap */}
                    <div></div>

                    {/* HS Code Column */}
                    <div className="flex flex-col gap-1 group relative">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 flex items-center gap-1">
                        HS Code <span className="text-red-500">*</span>
                        {itemErrors.hs_code && (
                          <span className="text-red-500" title="Error">⚠️</span>
                        )}
                        {/* Show warning for empty HS code or validation warnings */}
                        {!itemErrors.hs_code && (
                          (!item.hs_code || item.hs_code.trim() === '') ||
                          hsCodeValidations[index]?.warning
                        ) && (
                          <span className="text-amber-500" title={
                            (!item.hs_code || item.hs_code.trim() === '')
                              ? 'HS Code is required'
                              : hsCodeValidations[index]?.warning
                          }>⚠️</span>
                        )}
                      </span>
                      <div
                        className="relative"
                        ref={(el) => {
                          hsCodeFieldRefs.current[index] = el;
                        }}
                        onMouseEnter={() => handleHsCodeMouseEnter(index)}
                        onMouseLeave={handleHsCodeMouseLeave}
                      >
                        <input
                          ref={(el) => {
                            hsCodeInputRefs.current[index] = el;
                          }}
                          type="text"
                          value={item.hs_code ?? ''}
                          onChange={(e) => {
                            const value = e.target.value;
                            updateItem(index, 'hs_code', value);
                            searchHsCodes(index, value, item.type);
                          }}
                          onFocus={() => {
                            setFocusedHsCodeIndex(index);
                            // Clear hover tooltip when focusing input
                            setHoveredHsCode(null);
                            if (item.hs_code && item.hs_code.length >= 2) {
                              searchHsCodes(index, item.hs_code, item.type);
                            }
                          }}
                          onKeyDown={(e) => handleHsCodeKeyDown(e, index)}
                          placeholder="Search or type..."
                          className={`w-full h-[34px] rounded border px-2 py-1 font-mono text-xs focus:outline-none focus:ring-1 ${
                            itemErrors.hs_code
                              ? 'border-red-300 focus:border-red-400 focus:ring-red-400'
                              : (
                                ((!item.hs_code || item.hs_code.trim() === '') || hsCodeValidations[index]?.warning)
                                  ? 'border-amber-300 focus:border-amber-400 focus:ring-amber-300'
                                  : 'border-gray-300 focus:border-blue-400 focus:ring-blue-300'
                              )
                          }`}
                          autoComplete="off"
                          aria-autocomplete="list"
                          aria-expanded={focusedHsCodeIndex === index && (hsCodeSuggestions[index]?.length || 0) > 0}
                          aria-controls={`hs-code-dropdown-${index}`}
                        />
                        {itemErrors.hs_code && (
                          <div className="hidden group-hover:block absolute top-full left-0 mt-1 z-50 w-max max-w-[250px] bg-red-50 border border-red-200 rounded px-2 py-1 text-[11px] text-red-700 shadow-md">
                            {itemErrors.hs_code}
                          </div>
                        )}

                        {/* HS Code Autocomplete Dropdown */}
                        {focusedHsCodeIndex === index && (hsCodeSearchLoading[index] || (hsCodeSuggestions[index]?.length || 0) > 0) && (
                          <div
                            id={`hs-code-dropdown-${index}`}
                            ref={(el) => {
                              hsCodeDropdownRefs.current[index] = el;
                            }}
                            className="absolute top-full left-0 mt-1 w-[400px] max-h-[320px] overflow-y-auto bg-white border border-gray-300 rounded-lg shadow-xl z-[60]"
                            role="listbox"
                          >
                            {hsCodeSearchLoading[index] ? (
                              <div className="flex items-center justify-center py-4 text-sm text-gray-500">
                                <svg className="animate-spin h-4 w-4 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                Searching...
                              </div>
                            ) : (hsCodeSuggestions[index] || []).length > 0 ? (
                              <>
                                <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-50 border-b border-gray-200 sticky top-0">
                                  {item.type === 'Barang' ? 'Barang' : 'Jasa'} HS Codes ({hsCodeSuggestions[index].length} results)
                                </div>
                                {hsCodeSuggestions[index].map((suggestion, sugIndex) => (
                                  <div
                                    key={suggestion.id}
                                    role="option"
                                    aria-selected={selectedSuggestionIndex[index] === sugIndex}
                                    className={`px-3 py-2.5 cursor-pointer transition-colors border-b border-gray-100 last:border-b-0 ${
                                      selectedSuggestionIndex[index] === sugIndex
                                        ? 'bg-blue-50 border-blue-200'
                                        : 'hover:bg-gray-50'
                                    }`}
                                    onClick={() => selectHsCodeSuggestion(index, suggestion)}
                                    onMouseEnter={() => setSelectedSuggestionIndex(prev => ({ ...prev, [index]: sugIndex }))}
                                  >
                                    <div className="flex items-start gap-2">
                                      <div className="flex-shrink-0">
                                        <span className="inline-block px-2 py-0.5 text-xs font-mono font-semibold bg-gray-100 text-gray-800 rounded">
                                          {suggestion.code}
                                        </span>
                                        <span className="ml-1 inline-block px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700 rounded">
                                          {suggestion.level}
                                        </span>
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <div className="text-xs text-gray-900 font-medium line-clamp-1">
                                          {suggestion.descriptionEn}
                                        </div>
                                        <div className="text-[11px] text-gray-600 mt-0.5 line-clamp-2">
                                          {suggestion.descriptionId}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </>
                            ) : (
                              focusedHsCodeIndex === index && item.hs_code && item.hs_code.length >= 2 && !hsCodeSearchLoading[index] && (
                                <div className="px-3 py-4 text-center text-sm text-gray-500">
                                  No matching HS codes found
                                </div>
                              )
                            )}
                          </div>
                        )}

                        {/* HS Code Hover Tooltip - Only show when dropdown is not active */}
                        {hoveredHsCode?.index === index && hsCodeValidations[index]?.data && focusedHsCodeIndex !== index && (
                          <div
                            data-hs-tooltip
                            className={`absolute ${
                              hoveredHsCode.position === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'
                            } left-0 z-50 w-max max-w-[320px] rounded-lg border border-gray-200 bg-white shadow-xl`}
                            role="tooltip"
                            style={{ pointerEvents: 'auto' }}
                            onMouseEnter={() => handleHsCodeTooltipMouseEnter(index)}
                            onMouseLeave={handleHsCodeTooltipMouseLeave}
                          >
                            <div className="p-3">
                              <div className="flex items-start justify-between gap-2 mb-2">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="text-xs font-mono font-semibold text-gray-900">
                                      {hsCodeValidations[index].data.code}
                                    </span>
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                      hsCodeValidations[index].data.type === 'BARANG'
                                        ? 'bg-blue-100 text-blue-700'
                                        : 'bg-green-100 text-green-700'
                                    }`}>
                                      {hsCodeValidations[index].data.type === 'BARANG' ? 'Barang' : 'Jasa'}
                                    </span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-medium">
                                      {hsCodeValidations[index].data.level}
                                    </span>
                                  </div>
                                </div>
                                <a
                                  href={`/admin/hs-codes?search=${hsCodeValidations[index].data.code}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex-shrink-0 text-blue-600 hover:text-blue-800 transition-colors"
                                  title="Open in HS Code Management"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <svg
                                    className="w-4 h-4"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      strokeWidth={2}
                                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                                    />
                                  </svg>
                                </a>
                              </div>
                              <div className="border-t border-gray-100 pt-2">
                                {/* Language Tab Switcher */}
                                <div className="flex items-center gap-1 mb-2">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setHsCodeTooltipLang(prev => ({ ...prev, [index]: 'id' }));
                                    }}
                                    className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                                      (hsCodeTooltipLang[index] || 'id') === 'id'
                                        ? 'bg-blue-100 text-blue-700'
                                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                    }`}
                                  >
                                    🇮🇩 ID
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setHsCodeTooltipLang(prev => ({ ...prev, [index]: 'en' }));
                                    }}
                                    className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                                      hsCodeTooltipLang[index] === 'en'
                                        ? 'bg-blue-100 text-blue-700'
                                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                    }`}
                                  >
                                    🇬🇧 EN
                                  </button>
                                </div>
                                {/* Description Content */}
                                <div className="text-xs text-gray-700 leading-relaxed">
                                  <p className="whitespace-pre-wrap break-words leading-snug">
                                    {(hsCodeTooltipLang[index] || 'id') === 'id'
                                      ? hsCodeValidations[index].data.descriptionId
                                      : hsCodeValidations[index].data.descriptionEn
                                    }
                                  </p>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                        {/* HS Code Validation Warning */}
                        {hsCodeValidations[index]?.warning && (
                          <div className="absolute top-full left-0 mt-1 z-40 w-max max-w-[280px] bg-amber-50 border border-amber-300 rounded px-2 py-1.5 text-[11px] text-amber-800 shadow-md flex items-start gap-1.5">
                            <span className="text-amber-600 flex-shrink-0">⚠</span>
                            <span>{hsCodeValidations[index].warning}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Gap */}
                    <div></div>

                    {/* Qty Column */}
                    <div className="flex flex-col gap-1 group relative">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 flex items-center gap-1">
                        Qty <span className="text-red-500">*</span>
                        {itemErrors.qty && (
                          <span className="text-red-500" title="Error">⚠️</span>
                        )}
                      </span>
                      <div className="relative">
                        <input
                          type="number"
                          value={item.qty}
                          onChange={(e) => updateItem(index, 'qty', parseFloat(e.target.value) || 0)}
                          min="0"
                          step="any"
                          className={`w-full h-[34px] rounded border px-2 py-1 text-right tabular-nums focus:outline-none focus:ring-1 ${
                            itemErrors.qty
                              ? 'border-red-300 focus:border-red-400 focus:ring-red-400'
                              : 'border-gray-300 focus:border-blue-400 focus:ring-blue-300'
                          }`}
                        />
                        {itemErrors.qty && (
                          <div className="hidden group-hover:block absolute top-full left-0 mt-1 z-50 w-max max-w-[250px] bg-red-50 border border-red-200 rounded px-2 py-1 text-[11px] text-red-700 shadow-md">
                            {itemErrors.qty}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Gap */}
                    <div></div>

                    {/* UOM Column */}
                    <div className="flex flex-col gap-1 group relative">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 flex items-center gap-1">
                        UOM <span className="text-red-500">*</span>
                        {itemErrors.uom && (
                          <span className="text-red-500" title="Error">⚠️</span>
                        )}
                      </span>
                      <div className="relative">
                        <select
                          value={item.uom}
                          onChange={(e) => handleUomSelect(index, e.target.value)}
                          className={`w-full h-[34px] rounded border px-2 py-1 focus:outline-none focus:ring-1 ${
                            itemErrors.uom
                              ? 'border-red-300 focus:border-red-400 focus:ring-red-400'
                              : 'border-gray-300 focus:border-blue-400 focus:ring-blue-300'
                          }`}
                        >
                          <option value="">Select UOM</option>
                          {uomList.map(uom => (
                            <option key={uom.code} value={uom.code}>
                              {uom.name}
                            </option>
                          ))}
                        </select>
                        {itemErrors.uom && (
                          <div className="hidden group-hover:block absolute top-full left-0 mt-1 z-50 w-max max-w-[250px] bg-red-50 border border-red-200 rounded px-2 py-1 text-[11px] text-red-700 shadow-md">
                            {itemErrors.uom}
                          </div>
                        )}
                      </div>
                      {showApplyToAllUom && (
                        <button
                          type="button"
                          onClick={() => applyToAllUom && handleApplyUomToAll(applyToAllUom.uomCode)}
                          className="inline-flex items-center justify-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-600 hover:bg-blue-100"
                          aria-label="Apply selected UOM to all line items"
                        >
                          <span>📋</span>
                          <span>Apply all</span>
                        </button>
                      )}
                    </div>

                    {/* Gap */}
                    <div></div>

                    {/* Unit Price Column */}
                    <div className="flex flex-col gap-1 group relative">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 flex items-center gap-1">
                        Unit Price <span className="text-red-500">*</span>
                        {itemErrors.unit_price && (
                          <span className="text-red-500" title="Error">⚠️</span>
                        )}
                      </span>
                      <div className="relative">
                        <input
                          type="number"
                          value={item.unit_price}
                          onChange={(e) => updateItem(index, 'unit_price', parseFloat(e.target.value) || 0)}
                          min="0"
                          step="any"
                          className={`w-full h-[34px] rounded border px-2 py-1 text-right tabular-nums focus:outline-none focus:ring-1 ${
                            itemErrors.unit_price
                              ? 'border-red-300 focus:border-red-400 focus:ring-red-400'
                              : 'border-gray-300 focus:border-blue-400 focus:ring-blue-300'
                          }`}
                        />
                        {itemErrors.unit_price && (
                          <div className="hidden group-hover:block absolute top-full left-0 mt-1 z-50 w-max max-w-[250px] bg-red-50 border border-red-200 rounded px-2 py-1 text-[11px] text-red-700 shadow-md">
                            {itemErrors.unit_price}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Gap */}
                    <div></div>

                    {/* Total Column */}
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        Total
                      </span>
                      <div
                        className="rounded border border-gray-200 bg-gray-50 px-2 py-1 text-right font-semibold text-gray-800 tabular-nums h-[34px] flex items-center justify-end"
                        title={formatCurrency(lineTotal)}
                      >
                        {formatCurrency(lineTotal)}
                      </div>
                    </div>

                    {/* Gap */}
                    <div></div>

                    {/* Tax % Column */}
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        Tax %
                      </span>
                      <input
                        type="number"
                        value={taxRateValue}
                        onChange={(e) => updateItem(index, 'taxRate', parseFloat(e.target.value) || 0)}
                        min="0"
                        step="1"
                        className="w-full h-[34px] rounded border border-gray-300 px-2 py-1 text-right tabular-nums focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300"
                      />
                    </div>

                    {/* Gap */}
                    <div></div>

                    {/* Tax Base Column */}
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        Tax Base
                      </span>
                      <div
                        className="rounded border border-gray-200 bg-gray-50 px-2 py-1 text-right font-medium text-gray-800 tabular-nums h-[34px] flex items-center justify-end"
                        title={formatCurrency(taxBase)}
                      >
                        {formatCurrency(taxBase)}
                      </div>
                    </div>

                    {/* Gap */}
                    <div></div>

                    {/* Tax Amount Column */}
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        Tax Amount
                      </span>
                      <div
                        className="rounded border border-gray-200 bg-gray-50 px-2 py-1 text-right font-medium text-gray-800 tabular-nums h-[34px] flex items-center justify-end"
                        title={formatCurrency(taxAmount)}
                      >
                        {formatCurrency(taxAmount)}
                      </div>
                    </div>

                    {/* Gap */}
                    <div></div>

                    {/* Delete Button Column */}
                    <div className="relative self-end">
                      {showMergeHere && (
                        <div className="absolute bottom-full mb-1 right-0 transition-all duration-200">
                          <button
                            type="button"
                            onClick={() => handleMerge(item.id)}
                            disabled={mergeDisabled}
                            aria-disabled={mergeDisabled}
                            title={mergeButtonTitle}
                            className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs transition-colors ${
                              mergeDisabled
                                ? 'cursor-not-allowed text-gray-300'
                                : 'bg-blue-50 text-blue-600 hover:bg-blue-100'
                            }`}
                            aria-label={`Merge selected items into line ${index + 1}`}
                          >
                            ⇄
                          </button>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => handleDeleteItem(item.id)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-base text-gray-400 transition-colors hover:text-red-600"
                        aria-label={`Delete line item ${index + 1}`}
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
