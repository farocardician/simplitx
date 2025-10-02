'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import BuyerDropdown from '@/components/BuyerDropdown';

interface LineItem {
  no?: number;
  description: string;
  qty: number;
  unit_price: number;
  amount: number;
  sku?: string;
  hs_code: string;
  uom: string;
  type: 'Barang' | 'Jasa';
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
}

interface CandidateParty extends ResolvedParty {
  confidence: number;
}

interface InvoiceData {
  invoice_no: string;
  seller_name: string;
  buyer_name: string;
  invoice_date: string;
  items: LineItem[];
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

interface ItemErrors {
  description?: string;
  qty?: string;
  unit_price?: string;
  hs_code?: string;
  uom?: string;
  type?: string;
}

export default function ReviewPage() {
  const params = useParams();
  const router = useRouter();
  const jobId = params?.jobId as string;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [invoiceData, setInvoiceData] = useState<InvoiceData | null>(null);
  const [invoiceDate, setInvoiceDate] = useState('');
  const [items, setItems] = useState<LineItem[]>([]);
  const [initialSnapshot, setInitialSnapshot] = useState<{ invoiceDate: string; items: LineItem[] } | null>(null);
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

  useEffect(() => {
    if (!jobId) return;

    const fetchData = async () => {
      try {
        const [invoiceResponse, uomResponse, partiesResponse] = await Promise.all([
          fetch(`/api/review/${jobId}`),
          fetch('/api/uom'),
          fetch('/api/parties?limit=1000') // Fetch all parties for override capability
        ]);

        if (!invoiceResponse.ok) {
          const errorData = await invoiceResponse.json().catch(() => null);
          const errorMessage = errorData?.error?.message || `Failed to load invoice data (${invoiceResponse.status})`;
          throw new Error(errorMessage);
        }

        const invoiceData = await invoiceResponse.json();
        const uoms = uomResponse.ok ? await uomResponse.json() : [];

        // Fetch all parties for buyer override
        let parties: CandidateParty[] = [];
        if (partiesResponse.ok) {
          const partiesData = await partiesResponse.json();
          // Convert parties to CandidateParty format with neutral confidence
          parties = partiesData.parties.map((party: any) => ({
            ...party,
            confidence: 0.5 // Neutral score for manual selection
          }));
        }

        setInvoiceData(invoiceData);
        setInvoiceDate(invoiceData.invoice_date);
        setItems(invoiceData.items);
        setUomList(uoms);
        setAllParties(parties);

        // Save initial snapshot for dirty tracking
        setInitialSnapshot({
          invoiceDate: invoiceData.invoice_date,
          items: JSON.parse(JSON.stringify(invoiceData.items))
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

    const newErrors: Record<number, ItemErrors> = {};
    items.forEach((item, index) => {
      const itemErrors = validateItem(item, index);
      if (Object.keys(itemErrors).length > 0) {
        newErrors[index] = itemErrors;
      }
    });

    setErrors(newErrors);
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

  const updateItem = (index: number, field: keyof LineItem, value: any) => {
    setItems(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };

      // Live amount calculation
      if (field === 'qty' || field === 'unit_price') {
        const qty = field === 'qty' ? value : updated[index].qty;
        const unitPrice = field === 'unit_price' ? value : updated[index].unit_price;
        updated[index].amount = qty * unitPrice;
      }

      return updated;
    });

    // Validate on change
    const newItem = { ...items[index], [field]: value };
    if (field === 'qty' || field === 'unit_price') {
      const qty = field === 'qty' ? value : newItem.qty;
      const unitPrice = field === 'unit_price' ? value : newItem.unit_price;
      newItem.amount = qty * unitPrice;
    }

    const itemErrors = validateItem(newItem, index);
    setErrors(prev => ({
      ...prev,
      [index]: itemErrors
    }));
  };

  const handleTypeSelect = (index: number, type: 'Barang' | 'Jasa') => {
    // Update the current item
    updateItem(index, 'type', type);

    // Show "Apply to All" only if multiple items exist
    if (items.length > 1) {
      setApplyToAllState({ itemIndex: index, type });
    }
  };

  const handleApplyToAll = (type: 'Barang' | 'Jasa') => {
    // Apply the type to all items
    setItems(prev => prev.map(item => ({ ...item, type })));

    // Clear the "Apply to All" state immediately
    setApplyToAllState(null);
  };

  const handleUomSelect = (index: number, uomCode: string) => {
    // Update the current item
    updateItem(index, 'uom', uomCode);

    // Show "Apply to All" only if multiple items exist and UOM is not empty
    if (items.length > 1 && uomCode) {
      setApplyToAllUom({ itemIndex: index, uomCode });
    }
  };

  const handleApplyUomToAll = (uomCode: string) => {
    // Apply the UOM to all items
    setItems(prev => prev.map(item => ({ ...item, uom: uomCode })));

    // Clear the "Apply to All UOM" state immediately
    setApplyToAllUom(null);
  };

  // Dirty tracking
  const isDirty = useMemo(() => {
    if (!initialSnapshot) return false;

    if (invoiceDate !== initialSnapshot.invoiceDate) return true;

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
        current.type !== initial.type
      ) {
        return true;
      }
    }

    return false;
  }, [invoiceDate, items, initialSnapshot]);

  // Check if there are any validation errors
  const hasErrors = useMemo(() => {
    return Object.values(errors).some(itemErrors => Object.keys(itemErrors).length > 0);
  }, [errors]);

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

  const handleCancel = () => {
    router.push('/queue');
  };

  const handleSave = async () => {
    setSaveError(null); // Clear any previous save errors
    try {
      const response = await fetch(`/api/review/${jobId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
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
          buyer_party_id: selectedBuyerPartyId
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
          {/* Top Row */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex-1 min-w-0">
              <h1 className="text-base font-semibold text-gray-900 truncate">
                Review Invoice
              </h1>
              <p className="text-sm text-gray-600 truncate">
                <span className="font-medium">{invoiceData.invoice_no}</span>
                <span className="mx-2 text-gray-400">•</span>
                <span>{invoiceData.seller_name}</span>
                <span className="mx-2 text-gray-400">→</span>
                <a href="/admin/parties" target="_blank" className="text-blue-600 hover:text-blue-700 hover:underline">
                  {invoiceData.buyer_name}
                </a>
              </p>
            </div>
            <div className="flex items-center gap-2 ml-4">
              <button
                onClick={handleCancel}
                className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={(!isDirty && !buyerSelectionChanged) || hasErrors || buyerUnresolved}
                className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                Save XML
              </button>
            </div>
          </div>

          {/* Bottom Row - Invoice Date and Total */}
          <div className="flex items-center gap-6 pt-2 border-t">
            <div className="flex items-center gap-2">
              <label htmlFor="invoice-date" className="text-xs font-medium text-gray-600">
                Invoice Date
              </label>
              <input
                id="invoice-date"
                type="date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
                className="px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs font-medium text-gray-600">Total Amount</span>
              <span className="text-base font-bold text-gray-900">{formatCurrency(totalAmount)}</span>
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

        {/* Buyer Resolution Section */}
        {invoiceData && invoiceData.buyer_resolution_status && (
          <div className="mb-4 bg-white border rounded-lg p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">
                {invoiceData.buyer_resolution_status === 'auto' && (
                  <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-green-100 text-green-800">
                    ✓ Auto-matched
                  </span>
                )}
                {invoiceData.buyer_resolution_status === 'locked' && (
                  <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-blue-100 text-blue-800">
                    🔒 Confirmed
                  </span>
                )}
                {invoiceData.buyer_resolution_status === 'pending_confirmation' && (
                  <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-yellow-100 text-yellow-800">
                    ⚠ Confirm Match
                  </span>
                )}
                {invoiceData.buyer_resolution_status === 'pending_selection' && (
                  <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-red-100 text-red-800">
                    ⚠ Select Buyer
                  </span>
                )}
              </div>

              <div className="flex-1">
                <h3 className="text-sm font-medium text-gray-900 mb-2">Buyer Company</h3>

                {/* Auto-matched or Locked - Show dropdown with prefilled value and ALL parties for override */}
                {(invoiceData.buyer_resolution_status === 'auto' || invoiceData.buyer_resolution_status === 'locked') && invoiceData.buyer_resolved && (
                  <div>
                    <BuyerDropdown
                      candidates={allParties}
                      selectedId={selectedBuyerPartyId || invoiceData.buyer_resolved.id}
                      onChange={(id) => setSelectedBuyerPartyId(id)}
                      prefilledParty={invoiceData.buyer_resolved}
                      highlightThreshold={0.90}
                    />
                    {invoiceData.buyer_resolution_confidence && (
                      <p className="mt-1 text-xs text-gray-500">
                        Confidence: {(invoiceData.buyer_resolution_confidence * 100).toFixed(1)}%
                        {selectedBuyerPartyId && selectedBuyerPartyId !== invoiceData.buyer_resolved.id && (
                          <span className="ml-2 text-blue-600">• Modified</span>
                        )}
                      </p>
                    )}
                  </div>
                )}

                {/* Pending Confirmation - Show candidates with best matches highlighted */}
                {invoiceData.buyer_resolution_status === 'pending_confirmation' && (
                  <div>
                    <p className="text-xs text-gray-600 mb-2">
                      Please confirm the buyer match:
                    </p>
                    <BuyerDropdown
                      candidates={invoiceData.buyer_candidates || []}
                      selectedId={selectedBuyerPartyId}
                      onChange={(id) => setSelectedBuyerPartyId(id)}
                      highlightThreshold={0.86}
                    />
                    {buyerUnresolved && (
                      <p className="mt-1 text-xs text-red-600">
                        ⚠ You must select a buyer before saving
                      </p>
                    )}
                  </div>
                )}

                {/* Pending Selection - Show top 5 candidates only */}
                {invoiceData.buyer_resolution_status === 'pending_selection' && (
                  <div>
                    <p className="text-xs text-gray-600 mb-2">
                      Please select the buyer company:
                    </p>
                    <BuyerDropdown
                      candidates={invoiceData.buyer_candidates || []}
                      selectedId={selectedBuyerPartyId}
                      onChange={(id) => setSelectedBuyerPartyId(id)}
                      showTopOnly={true}
                    />
                    {buyerUnresolved && (
                      <p className="mt-1 text-xs text-red-600">
                        ⚠ You must select a buyer before saving
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Line Items Header */}
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-700">
            Line Items <span className="text-gray-500 font-normal">({items.length})</span>
          </h2>
        </div>

        {/* Line Items */}
        <div className="space-y-2 mb-6">
          {items.map((item, index) => {
            const itemErrors = errors[index] || {};
            const hasItemErrors = Object.keys(itemErrors).length > 0;

            return (
              <div
                key={index}
                className={`bg-white rounded-lg border transition-colors ${
                  hasItemErrors ? 'border-red-300' : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="p-3">
                  {/* Header Row - Item Number and Amount */}
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-medium text-gray-500">
                      #{item.no || index + 1}
                    </span>
                    <span className="text-sm font-semibold text-gray-900">
                      {formatCurrency(item.amount)}
                    </span>
                  </div>

                  {/* Main Row - Description, SKU, Qty, Unit Price */}
                  <div className="grid grid-cols-12 gap-2 mb-2">
                    {/* Description */}
                    <div className="col-span-5">
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Description <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={item.description}
                        onChange={(e) => updateItem(index, 'description', e.target.value)}
                        placeholder="Item description"
                        className={`w-full px-2 py-1.5 text-sm border rounded focus:outline-none focus:ring-1 ${
                          itemErrors.description
                            ? 'border-red-300 focus:ring-red-500'
                            : 'border-gray-300 focus:ring-blue-500'
                        }`}
                      />
                      {itemErrors.description && (
                        <p className="mt-0.5 text-xs text-red-600">{itemErrors.description}</p>
                      )}
                    </div>

                    {/* SKU (optional) */}
                    <div className="col-span-3">
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        SKU <span className="text-gray-400">(optional)</span>
                      </label>
                      <input
                        type="text"
                        value={item.sku || ''}
                        onChange={(e) => updateItem(index, 'sku', e.target.value)}
                        placeholder="SKU"
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>

                    {/* Qty */}
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Qty <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="number"
                        value={item.qty}
                        onChange={(e) => updateItem(index, 'qty', parseFloat(e.target.value) || 0)}
                        className={`w-full px-2 py-1.5 text-sm border rounded focus:outline-none focus:ring-1 ${
                          itemErrors.qty
                            ? 'border-red-300 focus:ring-red-500'
                            : 'border-gray-300 focus:ring-blue-500'
                        }`}
                        min="0"
                        step="any"
                      />
                      {itemErrors.qty && (
                        <p className="mt-0.5 text-xs text-red-600">{itemErrors.qty}</p>
                      )}
                    </div>

                    {/* Unit Price */}
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Unit Price <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="number"
                        value={item.unit_price}
                        onChange={(e) => updateItem(index, 'unit_price', parseFloat(e.target.value) || 0)}
                        className={`w-full px-2 py-1.5 text-sm border rounded focus:outline-none focus:ring-1 ${
                          itemErrors.unit_price
                            ? 'border-red-300 focus:ring-red-500'
                            : 'border-gray-300 focus:ring-blue-500'
                        }`}
                        min="0"
                        step="any"
                      />
                      {itemErrors.unit_price && (
                        <p className="mt-0.5 text-xs text-red-600">{itemErrors.unit_price}</p>
                      )}
                    </div>
                  </div>

                  {/* Second Row - UOM, HS Code, Type */}
                  <div className="grid grid-cols-12 gap-2">
                    {/* UOM */}
                    <div className="col-span-3">
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        <a href="/admin/uom" target="_blank" className="text-blue-600 hover:text-blue-700 hover:underline">
                          UOM
                        </a> <span className="text-red-500">*</span>
                      </label>
                      <select
                        value={item.uom}
                        onChange={(e) => handleUomSelect(index, e.target.value)}
                        className={`w-full px-2 py-1.5 text-sm border rounded focus:outline-none focus:ring-1 ${
                          itemErrors.uom
                            ? 'border-red-300 focus:ring-red-500'
                            : 'border-gray-300 focus:ring-blue-500'
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
                        <p className="mt-0.5 text-xs text-red-600">{itemErrors.uom}</p>
                      )}
                      {applyToAllUom?.itemIndex === index && items.length > 1 && (
                        <button
                          onClick={() => handleApplyUomToAll(applyToAllUom.uomCode)}
                          className="mt-1.5 w-full px-2 py-1 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded border border-blue-200 transition-all flex items-center justify-center gap-1"
                          aria-label="Apply selected UOM to all line items"
                        >
                          <span>📋</span>
                          <span>Apply to All</span>
                        </button>
                      )}
                    </div>

                    {/* HS Code */}
                    <div className="col-span-3">
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        HS Code <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={item.hs_code}
                        onChange={(e) => updateItem(index, 'hs_code', e.target.value)}
                        placeholder="000000"
                        className={`w-full px-2 py-1.5 text-sm font-mono border rounded focus:outline-none focus:ring-1 ${
                          itemErrors.hs_code
                            ? 'border-red-300 focus:ring-red-500'
                            : 'border-gray-300 focus:ring-blue-500'
                        }`}
                      />
                      {itemErrors.hs_code && (
                        <p className="mt-0.5 text-xs text-red-600">{itemErrors.hs_code}</p>
                      )}
                    </div>

                    {/* Type chips */}
                    <div className="col-span-3">
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Type <span className="text-red-500">*</span>
                      </label>
                      <div className="flex gap-1.5">
                        {(() => {
                          const showApplyToAll = items.length > 1 && applyToAllState?.itemIndex === index;
                          const applyToAllType = applyToAllState?.type;

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
                                className={`min-w-[100px] px-3 py-1 rounded-full text-xs font-medium transition-all text-center ${
                                  item.type === 'Barang'
                                    ? 'bg-blue-600 text-white shadow-sm'
                                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                }`}
                              >
                                {showApplyToAll && applyToAllType === 'Barang' ? 'Apply to All' : 'Barang'}
                              </button>
                              <button
                                onClick={() => {
                                  if (showApplyToAll && applyToAllType === 'Jasa') {
                                    handleApplyToAll('Jasa');
                                  } else {
                                    handleTypeSelect(index, 'Jasa');
                                  }
                                }}
                                className={`min-w-[100px] px-3 py-1 rounded-full text-xs font-medium transition-all text-center ${
                                  item.type === 'Jasa'
                                    ? 'bg-green-600 text-white shadow-sm'
                                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                }`}
                              >
                                {showApplyToAll && applyToAllType === 'Jasa' ? 'Apply to All' : 'Jasa'}
                              </button>
                            </>
                          );
                        })()}
                      </div>
                      {itemErrors.type && (
                        <p className="mt-0.5 text-xs text-red-600">{itemErrors.type}</p>
                      )}
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
