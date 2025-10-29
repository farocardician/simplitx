'use client';

import { useState, useEffect } from 'react';
import type { HsCodeType } from '@prisma/client';

interface Draft {
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
}

export default function ModerationQueuePage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('draft');
  const [filterKind, setFilterKind] = useState<string>('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // Review modal state
  const [reviewingDraft, setReviewingDraft] = useState<Draft | null>(null);
  const [reviewAction, setReviewAction] = useState<'approve' | 'reject' | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [editValues, setEditValues] = useState<Partial<Draft>>({});

  // Toast notifications
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Fetch drafts
  useEffect(() => {
    fetchDrafts();
  }, [filterStatus, filterKind, page]);

  // Auto-dismiss toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const fetchDrafts = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();

      if (filterStatus) params.append('status', filterStatus);
      if (filterKind) params.append('kind', filterKind);
      params.append('page', page.toString());
      params.append('pageSize', '20');

      const response = await fetch(`/api/products/drafts?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch drafts');

      const data = await response.json();
      setDrafts(data.drafts);
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

  const openReviewModal = (draft: Draft, action: 'approve' | 'reject') => {
    setReviewingDraft(draft);
    setReviewAction(action);
    setReviewNotes('');
    setEditMode(false);
    setEditValues({
      description: draft.description || '',
      hsCode: draft.hsCode || '',
      type: draft.type || undefined,
      uomCode: draft.uomCode || '',
      aliasDescription: draft.aliasDescription || '',
    });
  };

  const closeReviewModal = () => {
    setReviewingDraft(null);
    setReviewAction(null);
    setReviewNotes('');
    setEditMode(false);
    setEditValues({});
  };

  const handleReview = async () => {
    if (!reviewingDraft || !reviewAction) return;

    try {
      const requestBody: any = {
        action: reviewAction,
        reviewedBy: 'admin', // TODO: Get from auth context
        reviewNotes: reviewNotes || null,
      };

      // Include updates if in edit mode
      if (editMode && reviewAction === 'approve') {
        requestBody.updates = {
          description: editValues.description,
          hsCode: editValues.hsCode || null,
          type: editValues.type || null,
          uomCode: editValues.uomCode || null,
          aliasDescription: editValues.aliasDescription || null,
        };
      }

      const response = await fetch(`/api/products/drafts/${reviewingDraft.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || `Failed to ${reviewAction} draft`);
      }

      const result = await response.json();

      await fetchDrafts();
      closeReviewModal();

      if (reviewAction === 'approve') {
        showToast(`Draft approved and ${result.created.type} created successfully`);
      } else {
        showToast('Draft rejected');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : `Failed to ${reviewAction} draft`, 'error');
    }
  };

  const getStatusBadge = (status: string) => {
    const colors = {
      draft: 'bg-yellow-100 text-yellow-800',
      approved: 'bg-green-100 text-green-800',
      rejected: 'bg-red-100 text-red-800',
    };
    return colors[status as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  const getKindBadge = (kind: string) => {
    return kind === 'new_product' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800';
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Moderation Queue</h1>
        <p className="text-gray-600">Review and approve draft products</p>
      </div>

      {/* Toolbar */}
      <div className="mb-6 flex flex-col sm:flex-row gap-4">
        <select
          value={filterStatus}
          onChange={(e) => {
            setFilterStatus(e.target.value);
            setPage(1);
          }}
          className="px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Status</option>
          <option value="draft">Draft (Pending)</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>

        <select
          value={filterKind}
          onChange={(e) => {
            setFilterKind(e.target.value);
            setPage(1);
          }}
          className="px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Types</option>
          <option value="new_product">New Product</option>
          <option value="alias">Alias</option>
        </select>
      </div>

      {/* Stats */}
      <div className="mb-4 text-sm text-gray-600">
        Showing {drafts.length} of {total} drafts
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
          <p className="mt-2 text-gray-600">Loading drafts...</p>
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
                      Type
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Description
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      HS / Type / UOM
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Source
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Score
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {drafts.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                        No drafts found
                      </td>
                    </tr>
                  ) : (
                    drafts.map((draft) => (
                      <tr key={draft.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 text-xs font-medium rounded ${getKindBadge(draft.kind)}`}>
                            {draft.kind === 'new_product' ? 'New Product' : 'Alias'}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-sm font-medium text-gray-900">
                            {draft.kind === 'new_product' ? draft.description : draft.aliasDescription}
                          </div>
                          {draft.sourcePdfLineText && (
                            <div className="text-xs text-gray-500 mt-1 truncate max-w-xs">
                              {draft.sourcePdfLineText}
                            </div>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">
                          <div>{draft.hsCode || '-'}</div>
                          <div>{draft.type || '-'}</div>
                          <div>{draft.uomCode || '-'}</div>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">
                          {draft.sourceInvoiceId || '-'}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">
                          {draft.confidenceScore !== null ? draft.confidenceScore.toFixed(2) : '-'}
                        </td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 text-xs font-medium rounded ${getStatusBadge(draft.status)}`}>
                            {draft.status}
                          </span>
                          {draft.reviewedBy && (
                            <div className="text-xs text-gray-500 mt-1">
                              by {draft.reviewedBy}
                            </div>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right space-x-2">
                          {draft.status === 'draft' && (
                            <>
                              <button
                                onClick={() => openReviewModal(draft, 'approve')}
                                className="text-green-600 hover:text-green-800 font-medium"
                              >
                                Approve
                              </button>
                              <button
                                onClick={() => openReviewModal(draft, 'reject')}
                                className="text-red-600 hover:text-red-800 font-medium"
                              >
                                Reject
                              </button>
                            </>
                          )}
                          {draft.status !== 'draft' && (
                            <span className="text-gray-400">Reviewed</span>
                          )}
                        </td>
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

      {/* Review Modal */}
      {reviewingDraft && reviewAction && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-4">
              {reviewAction === 'approve' ? 'Approve Draft' : 'Reject Draft'}
            </h2>

            {/* Draft Details */}
            <div className="mb-4 p-4 bg-gray-50 rounded-lg space-y-2">
              <div className="flex items-center gap-2">
                <span className={`px-2 py-1 text-xs font-medium rounded ${getKindBadge(reviewingDraft.kind)}`}>
                  {reviewingDraft.kind === 'new_product' ? 'New Product' : 'Alias'}
                </span>
                <span className="text-sm text-gray-600">
                  Created: {new Date(reviewingDraft.createdAt).toLocaleDateString()}
                </span>
              </div>
              {reviewingDraft.sourceInvoiceId && (
                <div className="text-sm text-gray-600">
                  Source: {reviewingDraft.sourceInvoiceId}
                </div>
              )}
              {reviewingDraft.confidenceScore !== null && (
                <div className="text-sm text-gray-600">
                  Confidence: {(reviewingDraft.confidenceScore * 100).toFixed(1)}%
                </div>
              )}
            </div>

            {/* Edit Mode Toggle (only for approve) */}
            {reviewAction === 'approve' && (
              <div className="mb-4">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={editMode}
                    onChange={(e) => setEditMode(e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-sm font-medium">Edit before approving</span>
                </label>
              </div>
            )}

            {/* Fields */}
            <div className="space-y-4">
              {reviewingDraft.kind === 'new_product' ? (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Description
                    </label>
                    {editMode && reviewAction === 'approve' ? (
                      <input
                        type="text"
                        value={editValues.description || ''}
                        onChange={(e) => setEditValues({ ...editValues, description: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    ) : (
                      <div className="px-3 py-2 bg-gray-50 rounded">{reviewingDraft.description}</div>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        HS Code
                      </label>
                      {editMode && reviewAction === 'approve' ? (
                        <input
                          type="text"
                          value={editValues.hsCode || ''}
                          onChange={(e) => setEditValues({ ...editValues, hsCode: e.target.value })}
                          maxLength={6}
                          className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      ) : (
                        <div className="px-3 py-2 bg-gray-50 rounded">{reviewingDraft.hsCode || '-'}</div>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Type
                      </label>
                      {editMode && reviewAction === 'approve' ? (
                        <select
                          value={editValues.type || ''}
                          onChange={(e) => setEditValues({ ...editValues, type: e.target.value as any })}
                          className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="">-</option>
                          <option value="BARANG">BARANG</option>
                          <option value="JASA">JASA</option>
                        </select>
                      ) : (
                        <div className="px-3 py-2 bg-gray-50 rounded">{reviewingDraft.type || '-'}</div>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        UOM
                      </label>
                      {editMode && reviewAction === 'approve' ? (
                        <input
                          type="text"
                          value={editValues.uomCode || ''}
                          onChange={(e) => setEditValues({ ...editValues, uomCode: e.target.value.toUpperCase() })}
                          className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      ) : (
                        <div className="px-3 py-2 bg-gray-50 rounded">{reviewingDraft.uomCode || '-'}</div>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Alias Description
                    </label>
                    {editMode && reviewAction === 'approve' ? (
                      <input
                        type="text"
                        value={editValues.aliasDescription || ''}
                        onChange={(e) => setEditValues({ ...editValues, aliasDescription: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    ) : (
                      <div className="px-3 py-2 bg-gray-50 rounded">{reviewingDraft.aliasDescription}</div>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Target Product ID
                    </label>
                    <div className="px-3 py-2 bg-gray-50 rounded text-xs font-mono">{reviewingDraft.targetProductId}</div>
                  </div>
                </>
              )}

              {/* Review Notes */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Review Notes {reviewAction === 'reject' && '(required for reject)'}
                </label>
                <textarea
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={3}
                  placeholder="Add notes about this review..."
                />
              </div>
            </div>

            {/* Actions */}
            <div className="mt-6 flex justify-end space-x-3">
              <button
                onClick={closeReviewModal}
                className="px-4 py-2 border rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleReview}
                className={`px-4 py-2 rounded-lg text-white ${
                  reviewAction === 'approve'
                    ? 'bg-green-600 hover:bg-green-700'
                    : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                {reviewAction === 'approve' ? 'Approve' : 'Reject'}
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
    </div>
  );
}
