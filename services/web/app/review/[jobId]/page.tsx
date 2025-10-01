'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';

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

interface InvoiceData {
  invoice_no: string;
  seller_name: string;
  buyer_name: string;
  invoice_date: string;
  items: LineItem[];
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

  useEffect(() => {
    if (!jobId) return;

    const fetchData = async () => {
      try {
        const [invoiceResponse, uomResponse] = await Promise.all([
          fetch(`/api/review/${jobId}`),
          fetch('/api/uom')
        ]);

        if (!invoiceResponse.ok) {
          const errorData = await invoiceResponse.json().catch(() => null);
          const errorMessage = errorData?.error?.message || `Failed to load invoice data (${invoiceResponse.status})`;
          throw new Error(errorMessage);
        }

        const invoiceData = await invoiceResponse.json();
        const uoms = uomResponse.ok ? await uomResponse.json() : [];

        setInvoiceData(invoiceData);
        setInvoiceDate(invoiceData.invoice_date);
        setItems(invoiceData.items);
        setUomList(uoms);

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
          }))
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
                <span>{invoiceData.buyer_name}</span>
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
                disabled={!isDirty || hasErrors}
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
                        UOM <span className="text-red-500">*</span>
                      </label>
                      <select
                        value={item.uom}
                        onChange={(e) => updateItem(index, 'uom', e.target.value)}
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
                        <button
                          onClick={() => updateItem(index, 'type', 'Barang')}
                          className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                            item.type === 'Barang'
                              ? 'bg-blue-600 text-white shadow-sm'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}
                        >
                          Barang
                        </button>
                        <button
                          onClick={() => updateItem(index, 'type', 'Jasa')}
                          className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                            item.type === 'Jasa'
                              ? 'bg-green-600 text-white shadow-sm'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}
                        >
                          Jasa
                        </button>
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
