'use client';

// ============================================
// Segments domain slice — segments, membership, and segment folders.
// ============================================

import { useCallback } from 'react';
import { api } from '../api-client';
import type { ApiCallFn, SetStoreData, StoreData } from './types';

interface SegmentsSliceDeps {
  data: StoreData;
  setData: SetStoreData;
  apiCall: ApiCallFn;
}

export function useSegmentsSlice({ data, setData, apiCall }: SegmentsSliceDeps) {
  const addSegment = useCallback((name: string, description: string, folder: string = '') => {
    setData((prev) => {
      const maxOrder = prev.segments.filter((s) => s.folder === folder).reduce((max, s) => Math.max(max, s.order), -1);
      return {
        ...prev,
        segments: [...prev.segments, {
          segmentId: crypto.randomUUID(),
          name,
          description,
          count: 0,
          folder,
          order: maxOrder + 1,
        }],
      };
    });
    // API: create segment
    apiCall(() => api.segments.create({ name, description, folder_id: folder || null }));
  }, [apiCall, setData]);

  const deleteSegment = useCallback((segmentId: string) => {
    setData((prev) => {
      const seg = prev.segments.find((s) => s.segmentId === segmentId);
      if (!seg) return prev;
      const updatedContacts = prev.contacts.map((c) => ({
        ...c,
        segments: c.segments.filter((s) => s !== seg.name),
      }));
      return {
        ...prev,
        segments: prev.segments.filter((s) => s.segmentId !== segmentId),
        contacts: updatedContacts,
      };
    });
    // API: delete segment
    apiCall(() => api.segments.delete(segmentId));
  }, [apiCall, setData]);

  const renameSegment = useCallback((segmentId: string, newName: string) => {
    setData((prev) => {
      const seg = prev.segments.find((s) => s.segmentId === segmentId);
      if (!seg) return prev;
      const oldName = seg.name;
      return {
        ...prev,
        segments: prev.segments.map((s) =>
          s.segmentId === segmentId ? { ...s, name: newName } : s
        ),
        contacts: prev.contacts.map((c) => ({
          ...c,
          segments: c.segments.map((s) => s === oldName ? newName : s),
        })),
      };
    });
  }, [setData]);

  const addContactsToSegment = useCallback(async (contactIds: string[], segmentName: string) => {
    const seg = data.segments.find((s) => s.name === segmentName);
    if (!seg) return;

    try {
      await api.segments.addContacts(seg.segmentId, contactIds);
      setData((prev) => {
        const updatedContacts = prev.contacts.map((c) => {
          if (contactIds.includes(c.contactId) && !c.segments.includes(segmentName)) {
            return { ...c, segments: [...c.segments, segmentName] };
          }
          return c;
        });
        // Recount segment membership from updated contacts
        const newCount = updatedContacts.filter((c) => c.segments.includes(segmentName)).length;
        const updatedSegments = prev.segments.map((s) =>
          s.segmentId === seg.segmentId ? { ...s, count: newCount } : s
        );
        return { ...prev, contacts: updatedContacts, segments: updatedSegments };
      });
    } catch (err) {
      console.error('[API] Add contacts to segment failed:', err);
    }
  }, [data.segments, setData]);

  const removeContactsFromSegment = useCallback(async (contactIds: string[], segmentName: string) => {
    const seg = data.segments.find((s) => s.name === segmentName);
    if (!seg) return;

    try {
      await api.segments.removeContacts(seg.segmentId, contactIds);
      setData((prev) => {
        const updatedContacts = prev.contacts.map((c) => {
          if (contactIds.includes(c.contactId)) {
            return { ...c, segments: c.segments.filter((s) => s !== segmentName) };
          }
          return c;
        });
        const newCount = updatedContacts.filter((c) => c.segments.includes(segmentName)).length;
        const updatedSegments = prev.segments.map((s) =>
          s.segmentId === seg.segmentId ? { ...s, count: newCount } : s
        );
        return { ...prev, contacts: updatedContacts, segments: updatedSegments };
      });
    } catch (err) {
      console.error('[API] Remove contacts from segment failed:', err);
    }
  }, [data.segments, setData]);

  const moveSegmentToFolder = useCallback((segmentId: string, folder: string) => {
    setData((prev) => {
      const maxOrder = prev.segments.filter((s) => s.folder === folder).reduce((max, s) => Math.max(max, s.order), -1);
      return {
        ...prev,
        segments: prev.segments.map((s) =>
          s.segmentId === segmentId ? { ...s, folder, order: maxOrder + 1 } : s
        ),
      };
    });
  }, [setData]);

  const reorderSegments = useCallback((orderedIds: string[]) => {
    setData((prev) => ({
      ...prev,
      segments: prev.segments.map((s) => {
        const idx = orderedIds.indexOf(s.segmentId);
        return idx >= 0 ? { ...s, order: idx } : s;
      }),
    }));
  }, [setData]);

  // ---- SEGMENT FOLDERS ----

  const addSegmentFolder = useCallback((name: string) => {
    setData((prev) => {
      const folders = prev.segmentFolders || [];
      const maxOrder = folders.reduce((max, f) => Math.max(max, f.order), -1);
      return {
        ...prev,
        segmentFolders: [...folders, {
          folderId: crypto.randomUUID(),
          name,
          order: maxOrder + 1,
          isExpanded: true,
        }],
      };
    });
  }, [setData]);

  const deleteSegmentFolder = useCallback((folderId: string) => {
    setData((prev) => {
      const folders = prev.segmentFolders || [];
      const folder = folders.find((f) => f.folderId === folderId);
      if (!folder) return prev;
      return {
        ...prev,
        segmentFolders: folders.filter((f) => f.folderId !== folderId),
        segments: prev.segments.map((s) =>
          s.folder === folder.name ? { ...s, folder: '' } : s
        ),
      };
    });
  }, [setData]);

  const renameSegmentFolder = useCallback((folderId: string, newName: string) => {
    setData((prev) => {
      const folders = prev.segmentFolders || [];
      const folder = folders.find((f) => f.folderId === folderId);
      if (!folder) return prev;
      const oldName = folder.name;
      return {
        ...prev,
        segmentFolders: folders.map((f) =>
          f.folderId === folderId ? { ...f, name: newName } : f
        ),
        segments: prev.segments.map((s) =>
          s.folder === oldName ? { ...s, folder: newName } : s
        ),
      };
    });
  }, [setData]);

  const toggleFolderExpanded = useCallback((folderId: string) => {
    setData((prev) => ({
      ...prev,
      segmentFolders: (prev.segmentFolders || []).map((f) =>
        f.folderId === folderId ? { ...f, isExpanded: !f.isExpanded } : f
      ),
    }));
  }, [setData]);

  return {
    addSegment,
    deleteSegment,
    renameSegment,
    addContactsToSegment,
    removeContactsFromSegment,
    moveSegmentToFolder,
    reorderSegments,
    addSegmentFolder,
    deleteSegmentFolder,
    renameSegmentFolder,
    toggleFolderExpanded,
  };
}
