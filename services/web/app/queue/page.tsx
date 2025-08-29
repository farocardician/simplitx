'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { JobGrid } from '@/components/queue/JobGrid';
import { EmptyState } from '@/components/queue/EmptyState';
import { QueueHeader } from '@/components/queue/QueueHeader';
import { JobCardSkeleton } from '@/components/queue/JobCardSkeleton';
import { ErrorPanel } from '@/components/queue/ErrorPanel';
import { Toast } from '@/components/queue/Toast';

interface Job {
  id: string;
  filename: string;
  sizeFormatted: string;
  status: string;
  mapping: string;
  createdAt: string;
  completedAt: string | null;
  error: { code: string; message: string } | null;
  canDownload: boolean;
  hasArtifacts: boolean;
}

const PAGE_SIZE = 24;

export default function QueuePage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const router = useRouter();

  const intervalRef = useRef<NodeJS.Timeout>();
  const shouldPollRef = useRef(true);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const fetchJobs = useCallback(
    async (loadMore = false) => {
      try {
        if (loadMore) {
          setLoadingMore(true);
        } else {
          setLoading(true);
        }
        const params = new URLSearchParams({ limit: PAGE_SIZE.toString() });
        if (loadMore && cursor) {
          params.append('cursor', cursor);
        }
        const res = await fetch(`/api/jobs?${params.toString()}`);
        if (!res.ok) throw new Error('Failed to fetch jobs');
        const data = await res.json();

        setJobs(prev => (loadMore ? [...prev, ...data.jobs] : data.jobs));
        setCursor(data.nextCursor ?? null);
        setHasMore(Boolean(data.nextCursor));

        if (!loadMore && data.activeCount === 0 && intervalRef.current) {
          shouldPollRef.current = false;
          clearInterval(intervalRef.current);
          intervalRef.current = undefined;
        }

        setError(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setError(message);
        setToast(message);
      } finally {
        if (loadMore) {
          setLoadingMore(false);
        } else {
          setLoading(false);
        }
      }
    },
    [cursor]
  );

  useEffect(() => {
    shouldPollRef.current = true;
    fetchJobs(false);
    intervalRef.current = setInterval(() => {
      if (shouldPollRef.current) {
        fetchJobs(false);
      }
    }, 3000);
    return () => {
      shouldPollRef.current = false;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchJobs]);

  useEffect(() => {
    if (!hasMore) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && !loadingMore) {
          fetchJobs(true);
        }
      },
      { rootMargin: '200px' }
    );
    const node = loadMoreRef.current;
    if (node) observer.observe(node);
    return () => {
      if (node) observer.unobserve(node);
    };
  }, [hasMore, loadingMore, fetchJobs]);

  const handleUploadMore = () => {
    router.push('/');
  };

  const handleDownload = async (jobId: string) => {
    window.location.href = `/api/jobs/${jobId}/download`;
  };

  const handleDownloadArtifact = async (jobId: string) => {
    window.location.href = `/api/jobs/${jobId}/download-artifact`;
  };

  const handleDelete = async (jobId: string) => {
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;
    const confirmed = window.confirm(
      `Are you sure you want to delete "${job.filename}"?\n\nThis will permanently remove:\n• The XML result\n• The artifact files\n• The original PDF\n• All processing history\n\nThis action cannot be undone.`
    );
    if (!confirmed) return;
    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.error?.message || 'Failed to delete job');
      }
      setJobs(prevJobs => prevJobs.filter(j => j.id !== jobId));
    } catch (error) {
      console.error('Delete error:', error);
      setToast(
        `Failed to delete job: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  };

  const handleRetry = () => {
    fetchJobs(false);
  };

  return (
    <div className="container mx-auto p-4 md:p-8">
      <QueueHeader
        totalJobs={jobs.length}
        activeJobs={jobs.filter(j => ['uploaded', 'queued', 'processing'].includes(j.status)).length}
        onUploadMore={handleUploadMore}
      />

      {error && <ErrorPanel message={error} onRetry={handleRetry} />}

      {loading && jobs.length === 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 auto-rows-fr">
          {Array.from({ length: 8 }).map((_, i) => (
            <JobCardSkeleton key={i} />
          ))}
        </div>
      )}

      {!loading && jobs.length === 0 && !error && (
        <EmptyState onUploadFiles={handleUploadMore} />
      )}

      {jobs.length > 0 && (
        <>
          <JobGrid
            jobs={jobs}
            onDownload={handleDownload}
            onDownloadArtifact={handleDownloadArtifact}
            onDelete={handleDelete}
          />
          {loadingMore && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 auto-rows-fr mt-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <JobCardSkeleton key={i} />
              ))}
            </div>
          )}
          {hasMore && <div ref={loadMoreRef} className="h-1"></div>}
        </>
      )}

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
