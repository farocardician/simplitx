'use client';

import { useEffect, useRef, useState } from 'react';
import TransactionCodeDropdown from '@/components/TransactionCodeDropdown';
import { PartyRole } from '@/types/party-admin';

export interface TransactionCode {
  code: string;
  name: string;
  description: string;
}

export interface SellerOption {
  id: string;
  displayName: string;
  tinDisplay: string;
}

export interface PartyPayloadInput {
  displayName: string;
  tinDisplay: string;
  countryCode: string | null;
  transactionCode: string | null;
  addressFull: string | null;
  email: string | null;
  buyerDocument: string | null;
  buyerDocumentNumber: string | null;
  buyerIdtku: string | null;
  partyType: PartyRole;
  sellerId: string | null;
}

interface AddPartyFormProps {
  heading?: string;
  description?: string;
  submitLabel?: string;
  onSubmit: (data: PartyPayloadInput) => Promise<void> | void;
  onCancel: () => void;
  onError: (message: string) => void;
  transactionCodes: TransactionCode[];
  sellers: SellerOption[];
  sellersLoading: boolean;
  defaultValues?: Partial<PartyPayloadInput>;
  forceBuyerType?: boolean;
  className?: string;
}

export default function AddPartyForm({
  heading = 'Add New Party',
  description,
  submitLabel = 'Create Party',
  onSubmit,
  onCancel,
  onError,
  transactionCodes,
  sellers,
  sellersLoading,
  defaultValues,
  forceBuyerType = false,
  className
}: AddPartyFormProps) {
  const [displayName, setDisplayName] = useState(defaultValues?.displayName ?? '');
  const [tinDisplay, setTinDisplay] = useState(defaultValues?.tinDisplay ?? '');
  const [countryCode, setCountryCode] = useState(defaultValues?.countryCode ?? '');
  const [email, setEmail] = useState(defaultValues?.email ?? '');
  const [addressFull, setAddressFull] = useState(defaultValues?.addressFull ?? '');
  const [buyerDocument, setBuyerDocument] = useState(defaultValues?.buyerDocument ?? 'TIN');
  const [buyerDocumentNumber, setBuyerDocumentNumber] = useState(defaultValues?.buyerDocumentNumber ?? '');
  const [buyerIdtku, setBuyerIdtku] = useState(defaultValues?.buyerIdtku ?? '');
  const [transactionCode, setTransactionCode] = useState<string | null>(defaultValues?.transactionCode ?? null);
  const [partyType, setPartyType] = useState<PartyRole>(forceBuyerType ? 'buyer' : defaultValues?.partyType ?? 'buyer');
  const [sellerId, setSellerId] = useState(defaultValues?.sellerId ?? '');
  const [submitting, setSubmitting] = useState(false);
  const displayNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    displayNameRef.current?.focus();
  }, []);

  useEffect(() => {
    if (forceBuyerType) {
      setPartyType('buyer');
      setSellerId('');
    }
  }, [forceBuyerType]);

  useEffect(() => {
    setDisplayName(defaultValues?.displayName ?? '');
    setTinDisplay(defaultValues?.tinDisplay ?? '');
    setCountryCode(defaultValues?.countryCode ?? '');
    setEmail(defaultValues?.email ?? '');
    setAddressFull(defaultValues?.addressFull ?? '');
    setBuyerDocument(defaultValues?.buyerDocument ?? 'TIN');
    setBuyerDocumentNumber(defaultValues?.buyerDocumentNumber ?? '');
    setBuyerIdtku(defaultValues?.buyerIdtku ?? '');
    setTransactionCode(defaultValues?.transactionCode ?? null);
    setPartyType(forceBuyerType ? 'buyer' : defaultValues?.partyType ?? 'buyer');
    setSellerId(defaultValues?.sellerId ?? '');
  }, [
    defaultValues?.displayName,
    defaultValues?.tinDisplay,
    defaultValues?.countryCode,
    defaultValues?.email,
    defaultValues?.addressFull,
    defaultValues?.buyerDocument,
    defaultValues?.buyerDocumentNumber,
    defaultValues?.buyerIdtku,
    defaultValues?.transactionCode,
    defaultValues?.partyType,
    defaultValues?.sellerId,
    forceBuyerType
  ]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!displayName.trim() || !tinDisplay.trim()) {
      onError('Company name and TIN are required');
      return;
    }

    try {
      setSubmitting(true);
      const payload: PartyPayloadInput = {
        displayName: displayName.trim(),
        tinDisplay: tinDisplay.trim(),
        countryCode: countryCode.trim() ? countryCode.trim().toUpperCase() : null,
        transactionCode: transactionCode || null,
        email: email.trim() || null,
        addressFull: addressFull.trim() || null,
        buyerDocument: buyerDocument.trim() || null,
        buyerDocumentNumber: buyerDocumentNumber.trim() || null,
        buyerIdtku: buyerIdtku.trim() || null,
        partyType: forceBuyerType ? 'buyer' : partyType,
        sellerId: (forceBuyerType || partyType === 'seller') ? null : (sellerId || null)
      };

      await onSubmit(payload);

      setDisplayName('');
      setTinDisplay('');
      setCountryCode('');
      setTransactionCode(null);
      setEmail('');
      setAddressFull('');
      setBuyerDocument('TIN');
      setBuyerDocumentNumber('');
      setBuyerIdtku('');
      setPartyType('buyer');
      setSellerId('');
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Failed to add party');
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
    }
  };

  const containerClass = className || 'mb-6 p-6 bg-blue-50 border border-blue-200 rounded-lg';

  return (
    <div className={containerClass} onKeyDown={handleKeyDown}>
      <div className="flex items-center justify-between gap-2 mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">{heading}</h3>
          {description && <p className="text-sm text-gray-600 mt-1">{description}</p>}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-gray-500 hover:text-gray-700 transition-colors"
          aria-label="Close add party form"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

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
            <span className="block text-sm font-medium text-gray-700 mb-2">Party Type</span>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="party-type"
                  value="buyer"
                  checked={partyType === 'buyer'}
                  onChange={() => setPartyType('buyer')}
                  disabled={forceBuyerType}
                />
                Buyer
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="party-type"
                  value="seller"
                  checked={partyType === 'seller'}
                  onChange={() => setPartyType('seller')}
                  disabled={forceBuyerType}
                />
                Seller
              </label>
            </div>
            {forceBuyerType && (
              <p className="text-xs text-gray-500 mt-1">Party type locked to Buyer for this flow.</p>
            )}
          </div>
          {partyType === 'buyer' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Linked Seller
              </label>
              <select
                value={sellerId}
                onChange={(e) => setSellerId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={sellersLoading}
              >
                <option value="">Unlinked</option>
                {sellers.map((seller) => (
                  <option key={seller.id} value={seller.id}>
                    {seller.displayName} ({seller.tinDisplay})
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">Optional. Use when buyer reports for a specific seller.</p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Transaction Code
            </label>
            <TransactionCodeDropdown
              codes={transactionCodes}
              selectedCode={transactionCode}
              onChange={(code) => setTransactionCode(code)}
              compact
            />
            <p className="text-xs text-gray-500 mt-1">Helps categorize invoices and reporting.</p>
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
            <p className="text-xs text-gray-500 mt-1">Defaults to “TIN”, can be edited or cleared</p>
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

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={onCancel}
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
            {submitting ? 'Creating...' : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
