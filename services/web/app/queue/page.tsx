'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { QueuePageHeader } from './components/QueuePageHeader';
import { QueueDataGrid } from './components/QueueDataGrid';

interface Job {
  id: string;
  filename: string;
  bytes: number;
  sizeFormatted: string;
  status: string;
  mapping: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: { code: string; message: string } | null;
  canDownload: boolean;
  hasArtifacts: boolean;
  approved: boolean;
  approvedAt: string | null;
}

export default function QueuePage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [redirectCountdown, setRedirectCountdown] = useState<number | null>(null);
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set());
  const router = useRouter();
  
  // Simple polling with direct control
  const intervalRef = useRef<NodeJS.Timeout>();
  const shouldPollRef = useRef(true);
  const redirectIntervalRef = useRef<NodeJS.Timeout>();
  
  const fetchJobs = async () => {
    try {
      const res = await fetch('/api/jobs');
      if (!res.ok) throw new Error('Failed to fetch jobs');
      
      const data = await res.json();
      setJobs(data.jobs);
      
      console.log('Active count:', data.activeCount);
      
      // Check if no jobs at all - start redirect countdown
      if (data.jobs.length === 0) {
        console.log('No jobs found - starting redirect countdown');
        startRedirectCountdown();
      } else {
        // Stop redirect if jobs exist
        clearRedirectCountdown();
      }
      
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
  
  const startRedirectCountdown = () => {
    if (redirectIntervalRef.current) return; // Already started
    
    setRedirectCountdown(3);
    
    redirectIntervalRef.current = setInterval(() => {
      setRedirectCountdown((prev) => {
        if (prev === null || prev <= 1) {
          // Redirect to home
          router.push('/');
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };
  
  const clearRedirectCountdown = () => {
    if (redirectIntervalRef.current) {
      clearInterval(redirectIntervalRef.current);
      redirectIntervalRef.current = undefined;
    }
    setRedirectCountdown(null);
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
      clearRedirectCountdown();
    };
  }, []);
  
  const handleUploadMore = () => {
    router.push('/');
  };

  // Selection management
  const toggleJobSelection = (jobId: string) => {
    setSelectedJobIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(jobId)) {
        newSet.delete(jobId);
      } else {
        newSet.add(jobId);
      }
      return newSet;
    });
  };

  const selectAllJobs = () => {
    const allJobIds = new Set(jobs.map(job => job.id));
    setSelectedJobIds(allJobIds);
  };

  const clearSelection = () => {
    setSelectedJobIds(new Set());
  };

  // Clear selection when jobs change (e.g., after deletion)
  useEffect(() => {
    if (selectedJobIds.size > 0) {
      const currentJobIds = new Set(jobs.map(job => job.id));
      const validSelectedIds = new Set(
        Array.from(selectedJobIds).filter(id => currentJobIds.has(id))
      );
      if (validSelectedIds.size !== selectedJobIds.size) {
        setSelectedJobIds(validSelectedIds);
      }
    }
  }, [jobs, selectedJobIds]);
  
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
      setJobs(prevJobs => {
        const updatedJobs = prevJobs.filter(j => j.id !== jobId)
        
        // Check if this was the last job - start redirect countdown
        if (updatedJobs.length === 0) {
          console.log('Last job deleted - starting redirect countdown')
          startRedirectCountdown()
        }
        
        return updatedJobs
      });
    } catch (error) {
      console.error('Delete error:', error);
      alert(`Failed to delete job: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  // Bulk actions
  const handleBulkDownload = async () => {
    const selectedJobs = jobs.filter(job => 
      selectedJobIds.has(job.id) && job.canDownload
    );
    
    if (selectedJobs.length === 0) {
      alert('No downloadable jobs selected');
      return;
    }

    try {
      // Create ZIP with all selected XMLs
      const response = await fetch('/api/jobs/bulk-download', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jobIds: selectedJobs.map(job => job.id)
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.error?.message || 'Failed to download files');
      }

      // Download the ZIP file
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `xml-files-${selectedJobs.length}-files.zip`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      clearSelection();
    } catch (error) {
      console.error('Bulk download error:', error);
      alert(`Failed to download files: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleBulkDelete = async () => {
    const selectedJobs = jobs.filter(job => selectedJobIds.has(job.id));
    
    if (selectedJobs.length === 0) {
      alert('No jobs selected');
      return;
    }

    const fileNames = selectedJobs.map(job => job.filename).join('\n• ');
    const confirmed = window.confirm(
      `Are you sure you want to delete ${selectedJobs.length} job${selectedJobs.length > 1 ? 's' : ''}?\n\nFiles:\n• ${fileNames}\n\nThis will permanently remove:\n• The XML results\n• The artifact files\n• The original PDFs\n• All processing history\n\nThis action cannot be undone.`
    );

    if (!confirmed) return;

    // Delete jobs sequentially
    const failedDeletions = [];
    for (const job of selectedJobs) {
      try {
        const response = await fetch(`/api/jobs/${job.id}`, {
          method: 'DELETE'
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => null);
          throw new Error(errorData?.error?.message || 'Failed to delete job');
        }
      } catch (error) {
        console.error('Delete error:', error);
        failedDeletions.push(job.filename);
      }
    }

    // Update jobs list
    setJobs(prevJobs => {
      const updatedJobs = prevJobs.filter(job => !selectedJobIds.has(job.id));
      
      // Check if this resulted in no jobs - start redirect countdown
      if (updatedJobs.length === 0) {
        console.log('All jobs deleted - starting redirect countdown');
        startRedirectCountdown();
      }
      
      return updatedJobs;
    });

    clearSelection();

    // Show results
    if (failedDeletions.length > 0) {
      alert(`Some deletions failed:\n${failedDeletions.join('\n')}\n\nOther jobs were deleted successfully.`);
    }
  };
  
  if (loading && jobs.length === 0) {
    return <div className="flex justify-center p-8">Loading...</div>;
  }
  
  if (error) {
    return <div className="text-red-500 p-8">Error: {error}</div>;
  }
  
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <QueuePageHeader 
          jobs={jobs}
          selectedJobIds={selectedJobIds}
          onUploadMore={handleUploadMore}
          onBulkDownload={handleBulkDownload}
          onBulkDelete={handleBulkDelete}
        />
        
        <div className="mt-8 bg-white rounded-lg shadow">
          <QueueDataGrid
            jobs={jobs}
            selectedJobIds={selectedJobIds}
            onDownload={handleDownload}
            onDownloadArtifact={handleDownloadArtifact}
            onDelete={handleDelete}
            onToggleSelect={toggleJobSelection}
            onSelectAll={selectAllJobs}
            onClearSelection={clearSelection}
          />
          
          {jobs.length === 0 && redirectCountdown !== null && (
            <div className="p-8 text-center">
              <div className="text-gray-600 mb-2">No jobs in queue</div>
              <div className="text-sm text-gray-500">
                Redirecting to home in <span className="font-bold text-blue-600">{redirectCountdown}</span> second{redirectCountdown !== 1 ? 's' : ''}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}