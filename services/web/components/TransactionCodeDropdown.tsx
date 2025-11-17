'use client';

import { Fragment } from 'react';
import { Listbox, Transition } from '@headlessui/react';

interface TransactionCode {
  code: string;
  name: string;
  description: string;
}

interface Props {
  codes: TransactionCode[];
  selectedCode: string | null;
  onChange: (code: string) => void;
  required?: boolean;
  error?: string;
  compact?: boolean;
}

export default function TransactionCodeDropdown({
  codes,
  selectedCode,
  onChange,
  required = false,
  error,
  compact = false
}: Props) {
  const selected = codes.find(c => c.code === selectedCode);

  return (
    <div>
      {!compact && (
        <label className="block text-xs font-medium text-gray-700 mb-1.5">
          Transaction Code (Jenis Transaksi)
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}

      <Listbox value={selectedCode || ''} onChange={onChange}>
        <div className="relative">
          <div className={`relative w-full cursor-default overflow-hidden rounded-lg bg-white text-left border ${
            error ? 'border-red-300 focus-within:ring-red-500' : 'border-gray-300 focus-within:ring-blue-500'
          } focus-within:ring-2`}>
            <Listbox.Button className="relative w-full cursor-pointer py-2 pl-3 pr-10 text-left focus:outline-none text-sm">
              <span className="block truncate">
                {selected ? `${selected.code.padStart(2, '0')} – ${selected.name}` : 'Pilih kode transaksi...'}
              </span>
              <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
                <svg className="h-5 w-5 text-gray-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M10 3a.75.75 0 01.55.24l3.25 3.5a.75.75 0 11-1.1 1.02L10 4.852 7.3 7.76a.75.75 0 01-1.1-1.02l3.25-3.5A.75.75 0 0110 3zm-3.76 9.2a.75.75 0 011.06.04l2.7 2.908 2.7-2.908a.75.75 0 111.1 1.02l-3.25 3.5a.75.75 0 01-1.1 0l-3.25-3.5a.75.75 0 01.04-1.06z" clipRule="evenodd" />
                </svg>
              </span>
            </Listbox.Button>
          </div>

          <Transition
            as={Fragment}
            leave="transition ease-in duration-100"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <Listbox.Options className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md bg-white py-1 shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none text-sm">
              {codes
                .sort((a, b) => parseInt(a.code) - parseInt(b.code))
                .map((code) => (
                  <Listbox.Option
                    key={code.code}
                    value={code.code}
                    className={({ active }) =>
                      `relative cursor-pointer select-none py-2 px-3 ${
                        active ? 'bg-blue-50 text-blue-900' : 'text-gray-900'
                      }`
                    }
                  >
                    {({ selected: isSelected }) => (
                      <div>
                        <div className="flex items-center justify-between">
                          <span className={`block truncate ${isSelected ? 'font-semibold' : 'font-normal'}`}>
                            {code.code.padStart(2, '0')} – {code.name}
                          </span>
                          {isSelected && (
                            <svg className="h-5 w-5 text-blue-600 ml-2" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                            </svg>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5 pr-6">{code.description}</p>
                      </div>
                    )}
                  </Listbox.Option>
                ))}
            </Listbox.Options>
          </Transition>
        </div>
      </Listbox>

      {/* Helper Text - Only show in non-compact mode */}
      {!compact && !error && selected && selected.code === '4' && (
        <p className="mt-1 text-xs text-gray-500">
          Default: 04 (DPP Nilai Lain). Ubah jika jenis transaksi berbeda.
        </p>
      )}
      {!compact && !error && required && !selectedCode && (
        <p className="mt-1 text-xs text-gray-600">
          Jenis transaksi wajib dipilih sebelum menyimpan XML.
        </p>
      )}

      {/* Error always shows, even in compact mode */}
      {error && (
        <p className="mt-0.5 text-xs text-red-600">{error}</p>
      )}
    </div>
  );
}
