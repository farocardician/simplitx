'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { JobList } from '@/components/queue/JobList';
import { EmptyState } from '@/components/queue/EmptyState';
import { QueueHeader } from '@/components/queue/QueueHeader';

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

export default function QueuePage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  
  // Simple polling with direct control
  const intervalRef = useRef<NodeJS.Timeout>();
  const shouldPollRef = useRef(true);
  
  const fetchJobs = async () => {
    try {
      const res = await fetch('/api/jobs');
      if (!res.ok) throw new Error('Failed to fetch jobs');
      
      const data = await res.json();
      setJobs(data.jobs);
      
      console.log('Active count:', data.activeCount);
      
      // Stop polling if no active jobs
      if (data.activeCount === 0) {
        console.log('Stopping polling - no active jobs');
        shouldPollRef.current = false;
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = undefined;
        }
      }
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };
  
  useEffect(() => {
    console.log('Queue page mounted, starting polling');
    shouldPollRef.current = true;
    
    // Initial fetch
    fetchJobs();
    
    // Start polling
    intervalRef.current = setInterval(() => {
      if (shouldPollRef.current) {
        fetchJobs();
      }
    }, 3000);
    
    return () => {
      console.log('Queue page unmounting, stopping polling');
      shouldPollRef.current = false;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);
  
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

      // Remove job from the list
      setJobs(prevJobs => prevJobs.filter(j => j.id !== jobId));
    } catch (error) {
      console.error('Delete error:', error);
      alert(`Failed to delete job: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };
  
  if (loading && jobs.length === 0) {
    return <div className="flex justify-center p-8">Loading...</div>;
  }
  
  if (error) {
    return <div className="text-red-500 p-8">Error: {error}</div>;
  }
  
  return (
    <div className="container mx-auto p-4 md:p-8">
      <QueueHeader 
        totalJobs={jobs.length}
        activeJobs={jobs.filter(j => 
          ['uploaded', 'queued', 'processing'].includes(j.status)
        ).length}
        onUploadMore={handleUploadMore}
      />
      
      {jobs.length === 0 ? (
        <EmptyState onUploadFiles={handleUploadMore} />
      ) : (
        <JobList 
          jobs={jobs}
          onDownload={handleDownload}
          onDownloadArtifact={handleDownloadArtifact}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}