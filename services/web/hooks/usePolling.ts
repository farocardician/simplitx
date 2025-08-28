'use client';

import { useRef, useCallback, useEffect } from 'react';

interface UsePollingOptions {
  onPoll: (lastTimestamp?: string) => Promise<string | { timestamp: string; shouldStop: boolean }>;
  interval?: number;
  backoffMax?: number;
}

export function usePolling({ 
  onPoll, 
  interval = 3000,
  backoffMax = 10000 
}: UsePollingOptions) {
  const timeoutRef = useRef<NodeJS.Timeout>();
  const lastTimestampRef = useRef<string>();
  const backoffRef = useRef(interval);
  const isPollingRef = useRef(false);
  
  const poll = useCallback(async () => {
    if (!isPollingRef.current) return;
    
    try {
      const result = await onPoll(lastTimestampRef.current);
      
      // Handle both string and object returns
      if (typeof result === 'string') {
        lastTimestampRef.current = result;
      } else {
        lastTimestampRef.current = result.timestamp;
        if (result.shouldStop) {
          console.log('Polling stopped by onPoll callback');
          stopPolling();
          return;
        }
      }
      
      // Reset backoff on success
      backoffRef.current = interval;
      
    } catch (error) {
      // Exponential backoff on error
      backoffRef.current = Math.min(backoffRef.current * 2, backoffMax);
    }
    
    // Schedule next poll only if still polling
    if (isPollingRef.current) {
      timeoutRef.current = setTimeout(() => {
        if (isPollingRef.current) {
          poll();
        }
      }, backoffRef.current);
    }
  }, [onPoll, interval, backoffMax]);
  
  const startPolling = useCallback(() => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;
    poll();
  }, [poll]);
  
  const stopPolling = useCallback(() => {
    console.log('stopPolling called, isPolling:', isPollingRef.current);
    isPollingRef.current = false;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
  }, []);
  
  // Pause when tab is hidden
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else if (isPollingRef.current) {
        poll();
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [poll, stopPolling]);
  
  return { startPolling, stopPolling };
}