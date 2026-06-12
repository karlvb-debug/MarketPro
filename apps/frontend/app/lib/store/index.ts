'use client';

// ============================================
// Main Store Hook (workspace-aware) — composes the domain slices
// (contacts, segments, campaigns, templates, settings, inbox)
// into the single public `useStore()` API.
// ============================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWorkspace } from '../workspace';
import type { StoreData, WorkspaceSettings } from './types';
import { getDefaultSettings, getEmptyData } from './seed';
import { loadFromApi } from './load';
import { useContactsSlice } from './contacts';
import { useCampaignsSlice } from './campaigns';
import { useInboxSlice } from './inbox';
import { useSegmentsSlice } from './segments';
import { useTemplatesSlice } from './templates';
import { useSettingsSlice } from './settings';

// Re-export the full public surface (types, helpers, seed data)
export * from './types';
export * from './seed';
export { loadFromApi } from './load';

export function useStore() {
  const { activeWorkspace, hydrated: wsHydrated } = useWorkspace();
  const workspaceId = activeWorkspace.workspaceId;

  const [data, setData] = useState<StoreData>(getEmptyData);
  const [hydrated, setHydrated] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // Fire-and-forget API call helper
  const apiCall = useCallback(async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      console.error('[API] Call failed:', err);
      return null;
    }
  }, []);

  // ---- DOMAIN SLICES ----

  const {
    contactsMeta,
    contactsLoading,
    contactsFilter,
    setContactsFilter,
    loadContacts,
    addContact,
    updateContact,
    updateCompliance,
    deleteContact,
    bulkDeleteContacts,
    importContacts,
  } = useContactsSlice({ data, setData });

  const { addCampaign } = useCampaignsSlice({ setData, apiCall });

  const { markRead } = useInboxSlice({ setData, apiCall });

  const {
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
  } = useSegmentsSlice({ data, setData, apiCall });

  const {
    addEmailTemplate,
    addSmsTemplate,
    addVoiceTemplate,
    addWebForm,
    deleteTemplate,
    renameTemplate,
    moveTemplateToFolder,
    addTemplateFolder,
    deleteTemplateFolder,
    toggleTemplateFolderExpanded,
  } = useTemplatesSlice({ setData, apiCall });

  const {
    updateSettings,
    addCustomField,
    updateCustomField,
    deleteCustomField,
  } = useSettingsSlice({ setData, apiCall });

  // ---- LOAD / SYNC EFFECTS ----

  // Reload data from API when workspace changes
  useEffect(() => {
    if (!wsHydrated) return;
    setHydrated(false);
    setLoadError(false);
    setContactsFilter({ search: '', segmentId: null, status: '' });
    loadFromApi().then((apiData) => {
      setData(apiData ?? getEmptyData());
      setHydrated(true);
      if (!apiData) setLoadError(true);
    }).catch(() => {
      setData(getEmptyData());
      setHydrated(true);
      setLoadError(true);
    });
  }, [workspaceId, wsHydrated, setContactsFilter]);

  // Keep a ref to the latest loadContacts so the effect below doesn't need it
  // as a dependency — loadContacts changes identity whenever pagination state
  // updates, which would otherwise re-trigger the load in a loop.
  const loadContactsRef = useRef(loadContacts);
  useEffect(() => { loadContactsRef.current = loadContacts; }, [loadContacts]);

  // Synchronize contacts load when filters or workspace changes
  useEffect(() => {
    if (!wsHydrated) return;
    loadContactsRef.current(true);
  }, [workspaceId, wsHydrated, contactsFilter]);

  // ---- COMPUTED VALUES ----

  // Recompute segment counts from actual contact data
  const segments = data.segments.map((seg) => ({
    ...seg,
    count: data.contacts.filter((c) => c.segments.includes(seg.name)).length,
  }));

  // Ensure settings always has defaults (for stores created before settings existed)
  const settings: WorkspaceSettings = data.settings || getDefaultSettings();

  const stats = {
    totalContacts: contactsMeta.total,
    contactsChange: '',
    activeCampaigns: data.campaigns.filter((c) => ['sending', 'scheduled'].includes(c.status)).length,
    campaignsChange: '',
    messagesSent: data.campaigns.reduce((sum, c) => sum + c.delivered, 0),
    messagesChange: '',
    unreadInbox: data.inbox.filter((m) => !m.read).length,
    inboxChange: '',
  };

  // ---- RESET ----

  const resetData = useCallback(async () => {
    setData(getEmptyData());
    const fresh = await loadFromApi();
    if (fresh) setData(fresh);
  }, []);

  // Reload contacts + segments from API without wiping other data
  const refreshContacts = useCallback(async () => {
    try {
      const fresh = await loadFromApi();
      if (fresh) {
        setData((prev) => ({
          ...prev,
          segments: fresh.segments,
        }));
      }
      await loadContacts(true);
    } catch (err) {
      console.error('[API] Refresh contacts failed:', err);
    }
  }, [loadContacts]);

  return {
    ...data,
    segments,
    settings,
    stats,
    hydrated,
    loadError,
    contactsMeta,
    contactsLoading,
    contactsFilter,
    setContactsFilter,
    loadContacts,
    addContact,
    updateContact,
    updateCompliance,
    deleteContact,
    bulkDeleteContacts,
    importContacts,
    addCampaign,
    markRead,
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
    addSmsTemplate,
    addEmailTemplate,
    addVoiceTemplate,
    addWebForm,
    deleteTemplate,
    renameTemplate,
    moveTemplateToFolder,
    addTemplateFolder,
    deleteTemplateFolder,
    toggleTemplateFolderExpanded,
    updateSettings,
    addCustomField,
    updateCustomField,
    deleteCustomField,
    resetData,
    refreshContacts,
  };
}
