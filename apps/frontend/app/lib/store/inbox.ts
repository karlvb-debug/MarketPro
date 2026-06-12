'use client';

// ============================================
// Inbox domain slice.
// ============================================

import { useCallback } from 'react';
import { api } from '../api-client';
import type { ApiCallFn, SetStoreData } from './types';

interface InboxSliceDeps {
  setData: SetStoreData;
  apiCall: ApiCallFn;
}

export function useInboxSlice({ setData, apiCall }: InboxSliceDeps) {
  const markRead = useCallback((messageId: string) => {
    setData((prev) => ({
      ...prev,
      inbox: prev.inbox.map((m) =>
        m.messageId === messageId ? { ...m, read: true } : m
      ),
    }));
    // API: mark read
    apiCall(() => api.inbox.markRead(messageId));
  }, [apiCall, setData]);

  return { markRead };
}
