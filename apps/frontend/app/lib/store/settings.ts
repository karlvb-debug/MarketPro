'use client';

// ============================================
// Settings & custom fields domain slice.
// ============================================

import { useCallback } from 'react';
import { api } from '../api-client';
import { settingsToApi } from '../api-mappers';
import type { ApiCallFn, CustomField, SetStoreData, WorkspaceSettings } from './types';
import { getDefaultSettings } from './seed';

interface SettingsSliceDeps {
  setData: SetStoreData;
  apiCall: ApiCallFn;
}

export function useSettingsSlice({ setData, apiCall }: SettingsSliceDeps) {
  const updateSettings = useCallback((patch: Partial<WorkspaceSettings>) => {
    setData((prev) => ({
      ...prev,
      settings: { ...(prev.settings || getDefaultSettings()), ...patch },
    }));
    // API: update settings
    apiCall(() => api.settings.update(settingsToApi(patch)));
  }, [apiCall, setData]);

  const addCustomField = useCallback((field: Omit<CustomField, 'fieldId' | 'createdAt'>) => {
    const newField: CustomField = {
      ...field,
      fieldId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    setData((prev) => ({
      ...prev,
      settings: {
        ...(prev.settings || getDefaultSettings()),
        customFields: [...(prev.settings?.customFields || []), newField],
      },
    }));
  }, [setData]);

  const updateCustomField = useCallback((fieldId: string, patch: Partial<CustomField>) => {
    setData((prev) => ({
      ...prev,
      settings: {
        ...(prev.settings || getDefaultSettings()),
        customFields: (prev.settings?.customFields || []).map((f) =>
          f.fieldId === fieldId ? { ...f, ...patch } : f
        ),
      },
    }));
  }, [setData]);

  const deleteCustomField = useCallback((fieldId: string) => {
    setData((prev) => ({
      ...prev,
      settings: {
        ...(prev.settings || getDefaultSettings()),
        customFields: (prev.settings?.customFields || []).filter((f) => f.fieldId !== fieldId),
      },
    }));
  }, [setData]);

  return {
    updateSettings,
    addCustomField,
    updateCustomField,
    deleteCustomField,
  };
}
