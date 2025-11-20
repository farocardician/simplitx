'use client';

import { useState, useRef } from 'react';

interface ValidationError {
  field: string;
  error: string;
}

interface ErrorDetail {
  type?: string;
  message?: string;
  stage?: string;
  validationErrors?: ValidationError[];
}

interface ProgressCellProps {
  status: string;
  error: { code: string; message: string } | null;
}

function parseValidationErrors(errorMessage: string): ErrorDetail | null {
  try {
    // Try to parse as JSON (for structured validation errors)
    const parsed = JSON.parse(errorMessage);
    if (parsed.type === 'validation_error' && parsed.validationErrors) {
      return parsed;
    }
  } catch {
    // Not JSON, continue
  }
  return null;
}

function formatFieldName(field: string): string {
  // Convert field names to readable format
  return field
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatErrorType(error: string): string {
  // Convert error types to readable format
  return error
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function ProgressCell({ status, error }: ProgressCellProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleMouseEnter = () => {
    // Clear any pending hide timeout
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    setShowTooltip(true);
  };

  const handleMouseLeave = () => {
    // Add delay before hiding tooltip (500ms)
    hideTimeoutRef.current = setTimeout(() => {
      setShowTooltip(false);
    }, 500);
  };

  if (status === 'processing') {
    return (
      <div className="w-full">
        <div className="w-full bg-blue-200 rounded-full h-2 overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full progress-indeterminate" />
        </div>
      </div>
    );
  }

  if (status === 'failed' && error?.message) {
    const validationError = parseValidationErrors(error.message);

    if (validationError && validationError.validationErrors) {
      // Show validation error with hover tooltip
      return (
        <div className="relative inline-block">
          <div
            className="flex items-center gap-1 text-xs text-amber-600 cursor-help"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            <svg
              className="w-4 h-4 flex-shrink-0"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                clipRule="evenodd"
              />
            </svg>
            <span className="truncate max-w-xs">
              {validationError.message || 'Validation failed'}
            </span>
          </div>

          {/* Tooltip */}
          {showTooltip && (
            <div
              className="absolute left-0 top-full mt-1 z-50 w-max max-w-sm bg-gray-900 text-white text-xs rounded-lg shadow-lg p-3"
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              <div className="font-semibold mb-2">
                {validationError.stage ? `${validationError.stage} Validation errors:` : 'Validation errors:'}
              </div>
              <ul className="space-y-1">
                {validationError.validationErrors.map((err, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <span className="text-red-400">•</span>
                    <span>
                      <span className="font-medium">{formatFieldName(err.field)}:</span>{' '}
                      <span className="text-gray-300">{formatErrorType(err.error)}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {/* Tooltip arrow */}
              <div className="absolute -top-1 left-4 w-2 h-2 bg-gray-900 transform rotate-45" />
            </div>
          )}
        </div>
      );
    }

    // Check if it's a server error with detailed message (e.g., "Internal server error: ...")
    const serverErrorMatch = error.message.match(/^(Internal server error|Gateway processing error):\s*(.+)$/);
    if (serverErrorMatch) {
      const [, errorType, detailMessage] = serverErrorMatch;

      return (
        <div className="relative inline-block">
          <div
            className="flex items-center gap-1 text-xs text-amber-600 cursor-help"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            <svg
              className="w-4 h-4 flex-shrink-0"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                clipRule="evenodd"
              />
            </svg>
            <span className="truncate max-w-xs">
              {errorType}
            </span>
          </div>

          {/* Tooltip */}
          {showTooltip && (
            <div
              className="absolute left-0 top-full mt-1 z-50 w-max max-w-md bg-gray-900 text-white text-xs rounded-lg shadow-lg p-3"
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              <div className="font-semibold mb-1">Error details:</div>
              <div className="text-gray-300">{detailMessage}</div>
              {/* Tooltip arrow */}
              <div className="absolute -top-1 left-4 w-2 h-2 bg-gray-900 transform rotate-45" />
            </div>
          )}
        </div>
      );
    }

    // Fallback for other errors (no tooltip)
    return (
      <div className="text-xs text-red-600 truncate" title={error.message}>
        {error.message}
      </div>
    );
  }

  return (
    <span className="text-gray-400 text-sm">—</span>
  );
}
