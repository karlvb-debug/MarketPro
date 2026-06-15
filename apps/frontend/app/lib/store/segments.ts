'use client';

// ============================================
// Segments domain slice — segments, membership, and segment folders.
// ============================================

import { useCallback } from 'react';
import { api, ApiError } from '../api-client';
import { mapRawSegment } from '../api-mappers';
import { showToast } from '../../components/ui/Toast';
import type { ApiCallFn, RawSegmentRow, RuleGroup, SetStoreData, Segment, StoreData } from './types';

interface SegmentsSliceDeps {
  data: StoreData;
  setData: SetStoreData;
  apiCall: ApiCallFn;
}

export interface CreateSegmentInput {
  name: string;
  description?: string;
  folder?: string;
  color?: string | null;
  kind?: 'static' | 'dynamic';
  rules?: RuleGroup | null;
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
          kind: 'static',
          rules: null,
          cachedCount: null,
          countRefreshedAt: null,
        }],
      };
    });
    // API: create segment
    apiCall(() => api.segments.create({ name, description, folder_id: folder || null }));
  }, [apiCall, setData]);

  /**
   * Create a static OR dynamic (rule-based) segment. Optimistic insert with
   * rollback on failure; the server response is the source of truth for the
   * real id and the dynamic cachedCount. Dynamic segments never touch the
   * static add-contacts endpoint — membership is rule-driven server-side.
   * Returns the created segment id on success, or null on failure (a toast is
   * shown on failure).
   */
  const createSegment = useCallback(async (input: CreateSegmentInput): Promise<string | null> => {
    const folder = input.folder || '';
    const kind = input.kind === 'dynamic' ? 'dynamic' : 'static';
    const tempId = crypto.randomUUID();

    let order = 0;
    setData((prev) => {
      order = prev.segments.filter((s) => s.folder === folder).reduce((max, s) => Math.max(max, s.order), -1) + 1;
      const optimistic: Segment = {
        segmentId: tempId,
        name: input.name,
        description: input.description || '',
        count: 0,
        folder,
        order,
        color: input.color || undefined,
        kind,
        rules: kind === 'dynamic' ? (input.rules ?? null) : null,
        cachedCount: kind === 'dynamic' ? 0 : null,
        countRefreshedAt: null,
      };
      return { ...prev, segments: [...prev.segments, optimistic] };
    });

    try {
      const row = await api.segments.create({
        name: input.name,
        description: input.description,
        color: input.color ?? null,
        folder_id: folder || null,
        kind,
        rules: kind === 'dynamic' ? input.rules : undefined,
      }) as RawSegmentRow;

      const mapped = mapRawSegment(row);
      // Preserve the local folder/order — the server doesn't echo folder name.
      setData((prev) => ({
        ...prev,
        segments: prev.segments.map((s) =>
          s.segmentId === tempId ? { ...mapped, folder, order } : s
        ),
      }));
      return mapped.segmentId;
    } catch (err) {
      // Roll back the optimistic insert.
      setData((prev) => ({ ...prev, segments: prev.segments.filter((s) => s.segmentId !== tempId) }));
      const message = (err as Partial<ApiError> | null)?.message || 'Failed to create segment.';
      showToast(message, 'error');
      return null;
    }
  }, [setData]);

  /**
   * Update a segment's name/description/color and (dynamic only) its rules.
   * Optimistic patch with rollback; for rule edits the server recomputes the
   * cachedCount, so we refresh it from a follow-up preview.
   * Returns an error string on failure, or null on success.
   */
  const updateSegment = useCallback(async (
    segmentId: string,
    patch: { name?: string; description?: string; color?: string | null; rules?: RuleGroup | null },
  ): Promise<string | null> => {
    let snapshot: Segment | undefined;
    setData((prev) => {
      snapshot = prev.segments.find((s) => s.segmentId === segmentId);
      if (!snapshot) return prev;
      const isDynamic = snapshot.kind === 'dynamic';
      return {
        ...prev,
        segments: prev.segments.map((s) =>
          s.segmentId === segmentId
            ? {
                ...s,
                name: patch.name ?? s.name,
                description: patch.description ?? s.description,
                color: patch.color === undefined ? s.color : (patch.color || undefined),
                // Rule edits only apply to dynamic segments (mirrors the backend).
                rules: isDynamic && patch.rules !== undefined ? patch.rules : s.rules,
              }
            : s
        ),
      };
    });
    if (!snapshot) return 'Segment not found.';
    const wasDynamic = snapshot.kind === 'dynamic';

    try {
      await api.segments.update(segmentId, {
        name: patch.name,
        description: patch.description,
        color: patch.color,
        rules: wasDynamic ? (patch.rules ?? undefined) : undefined,
      });

      // The PUT recomputes cachedCount for rule edits but returns only a
      // message; refresh the count from the preview endpoint so the list
      // reflects the new membership.
      if (wasDynamic && patch.rules) {
        const rules = patch.rules;
        apiCall(() => api.segments.previewCount(rules)).then((res) => {
          if (res && typeof res.total === 'number') {
            setData((prev) => ({
              ...prev,
              segments: prev.segments.map((s) =>
                s.segmentId === segmentId
                  ? { ...s, cachedCount: res.total, count: res.total, countRefreshedAt: new Date().toISOString() }
                  : s
              ),
            }));
          }
        });
      }
      return null;
    } catch (err) {
      const restore = snapshot;
      if (restore) {
        setData((prev) => ({
          ...prev,
          segments: prev.segments.map((s) => (s.segmentId === segmentId ? restore : s)),
        }));
      }
      const message = (err as Partial<ApiError> | null)?.message || 'Failed to update segment — changes were reverted.';
      showToast(message, 'error');
      return message;
    }
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
    createSegment,
    updateSegment,
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
