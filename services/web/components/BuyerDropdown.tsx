'use client';

import { Fragment, useState } from 'react';
import { Combobox, Transition } from '@headlessui/react';

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

interface BuyerDropdownProps {
  candidates: CandidateParty[];
  selectedId: string | null;
  onChange: (partyId: string) => void;
  prefilledParty?: ResolvedParty;
  prefilledConfidence?: number | null;
  showTopOnly?: boolean;
  highlightThreshold?: number;
}

export default function BuyerDropdown({
  candidates,
  selectedId,
  onChange,
  prefilledParty,
  prefilledConfidence,
  showTopOnly = false,
  highlightThreshold = 0.86
}: BuyerDropdownProps) {
  const [query, setQuery] = useState('');

  // Determine scenario
  const isMatched = !!prefilledParty;
  const isNotMatched = showTopOnly && !prefilledParty;
  const isSomeCandidates = !isMatched && !isNotMatched;

  // Always show all candidates (no filtering by showTopOnly)
  const displayCandidates = candidates;

  // Always show scores - never hide them
  const hideScores = false;

  // Combine prefilled party with candidates for full list, avoiding duplicates
  const allParties: (CandidateParty | ResolvedParty)[] = (() => {
    if (!prefilledParty) return displayCandidates;

    // Filter out the prefilled party from candidates to avoid duplicates
    const filteredCandidates = displayCandidates.filter(c => c.id !== prefilledParty.id);

    const resolvedConfidence = typeof prefilledConfidence === 'number'
      ? prefilledConfidence
      : 1.0;

    return [
      { ...prefilledParty, confidence: resolvedConfidence } as CandidateParty,
      ...filteredCandidates
    ];
  })();

  // Filter based on search query
  const filteredParties = query === ''
    ? allParties
    : allParties.filter((party) => {
        const searchText = `${party.displayName} ${party.tinDisplay}`.toLowerCase();
        return searchText.includes(query.toLowerCase());
      });

  // Split into best matches and others
  const bestMatches = filteredParties.filter(
    p => 'confidence' in p && p.confidence >= highlightThreshold
  );
  const otherMatches = filteredParties.filter(
    p => !('confidence' in p) || p.confidence < highlightThreshold
  );

  // Find selected party
  const selectedParty = allParties.find(p => p.id === selectedId);

  // Format confidence score
  const formatConfidence = (confidence: number): string => {
    return `${(confidence * 100).toFixed(1)}%`;
  };

  // Get score color
  const getScoreColor = (confidence: number): string => {
    if (confidence >= 0.90) return 'text-green-600';
    if (confidence >= 0.80) return 'text-yellow-600';
    return 'text-gray-500';
  };

  return (
    <Combobox value={selectedId} onChange={onChange}>
      <div className="relative">
        <div className="relative w-full cursor-default overflow-hidden rounded-lg bg-white text-left border border-gray-300 focus-within:ring-2 focus-within:ring-blue-500">
          <Combobox.Input
            className="w-full border-none py-2 pl-3 pr-10 text-sm leading-5 text-gray-900 focus:ring-0 focus:outline-none"
            displayValue={() => {
              if (selectedParty) {
                const baseDisplay = `${selectedParty.displayName} (${selectedParty.tinDisplay})`;
                // Always show score if available
                if ('confidence' in selectedParty) {
                  return `${baseDisplay} ${formatConfidence(selectedParty.confidence)}`;
                }
                return baseDisplay;
              }
              return '';
            }}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search buyer company..."
          />
          <Combobox.Button className="absolute inset-y-0 right-0 flex items-center pr-2">
            <svg
              className="h-5 w-5 text-gray-400"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M10 3a.75.75 0 01.55.24l3.25 3.5a.75.75 0 11-1.1 1.02L10 4.852 7.3 7.76a.75.75 0 01-1.1-1.02l3.25-3.5A.75.75 0 0110 3zm-3.76 9.2a.75.75 0 011.06.04l2.7 2.908 2.7-2.908a.75.75 0 111.1 1.02l-3.25 3.5a.75.75 0 01-1.1 0l-3.25-3.5a.75.75 0 01.04-1.06z"
                clipRule="evenodd"
              />
            </svg>
          </Combobox.Button>
        </div>

        <Transition
          as={Fragment}
          leave="transition ease-in duration-100"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
          afterLeave={() => setQuery('')}
        >
          <Combobox.Options className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md bg-white py-1 text-base shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm">
            {filteredParties.length === 0 ? (
              <div className="relative cursor-default select-none py-2 px-4 text-gray-700">
                {query === ''
                  ? 'No buyer companies available. Add one from the Parties admin page.'
                  : 'No companies match your search.'}
              </div>
            ) : (
              <>
                {/* Best Matches Section */}
                {bestMatches.length > 0 && !hideScores && (
                  <>
                    <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider bg-gray-50">
                      Best Matches
                    </div>
                    {bestMatches.map((party) => (
                      <Combobox.Option
                        key={party.id}
                        className={({ active }) =>
                          `relative cursor-pointer select-none py-2 pl-3 pr-9 ${
                            active ? 'bg-blue-50 text-blue-900' : 'text-gray-900'
                          }`
                        }
                        value={party.id}
                      >
                        {({ selected, active }) => (
                          <>
                            <div className="flex items-center justify-between">
                              <div className="flex-1 truncate">
                                <span className={`block truncate ${selected ? 'font-semibold' : 'font-normal'}`}>
                                  {party.displayName}
                                </span>
                                <span className="block text-xs text-gray-500 truncate">
                                  {party.tinDisplay}
                                  {party.countryCode && ` • ${party.countryCode}`}
                                </span>
                              </div>
                              {'confidence' in party && !hideScores && (
                                <span
                                  className={`ml-2 text-xs font-medium ${getScoreColor(party.confidence)}`}
                                >
                                  {formatConfidence(party.confidence)}
                                </span>
                              )}
                            </div>
                            {selected && (
                              <span
                                className={`absolute inset-y-0 right-0 flex items-center pr-3 ${
                                  active ? 'text-blue-600' : 'text-blue-600'
                                }`}
                              >
                                <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                  <path
                                    fillRule="evenodd"
                                    d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
                                    clipRule="evenodd"
                                  />
                                </svg>
                              </span>
                            )}
                          </>
                        )}
                      </Combobox.Option>
                    ))}
                  </>
                )}

                {/* Other Companies Section */}
                {otherMatches.length > 0 && bestMatches.length > 0 && !hideScores && (
                  <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider bg-gray-50 border-t">
                    Other Companies
                  </div>
                )}

                {/* Render other companies or all if no best matches */}
                {(bestMatches.length === 0 || hideScores ? filteredParties : otherMatches).map((party) => (
                  <Combobox.Option
                    key={party.id}
                    className={({ active }) =>
                      `relative cursor-pointer select-none py-2 pl-3 pr-9 ${
                        active ? 'bg-blue-50 text-blue-900' : 'text-gray-900'
                      }`
                    }
                    value={party.id}
                  >
                    {({ selected, active }) => (
                      <>
                        <div className="flex items-center justify-between">
                          <div className="flex-1 truncate">
                            <span className={`block truncate ${selected ? 'font-semibold' : 'font-normal'}`}>
                              {party.displayName}
                            </span>
                            <span className="block text-xs text-gray-500 truncate">
                              {party.tinDisplay}
                              {party.countryCode && ` • ${party.countryCode}`}
                            </span>
                          </div>
                          {'confidence' in party && !hideScores && (
                            <span
                              className={`ml-2 text-xs font-medium ${getScoreColor(party.confidence)}`}
                            >
                              {formatConfidence(party.confidence)}
                            </span>
                          )}
                        </div>
                        {selected && (
                          <span
                            className={`absolute inset-y-0 right-0 flex items-center pr-3 ${
                              active ? 'text-blue-600' : 'text-blue-600'
                            }`}
                          >
                            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                              <path
                                fillRule="evenodd"
                                d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
                                clipRule="evenodd"
                              />
                            </svg>
                          </span>
                        )}
                      </>
                    )}
                  </Combobox.Option>
                ))}
              </>
            )}
          </Combobox.Options>
        </Transition>
      </div>
    </Combobox>
  );
}
