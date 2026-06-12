'use client';

// ============================================
// Settings & custom fields domain slice.
// Custom field definitions are persisted via /custom-fields:
// - key and type are immutable after creation
// - DELETE archives (definitions are never destroyed)
// ============================================

import { useCallback } from 'react';
import { api, ApiError } from '../api-client';
import { settingsToApi, mapApiCustomField } from '../api-mappers';
import { showToast } from '../../components/ui/Toast';
import type { ApiCallFn, CustomField, RawCustomFieldRow, SetStoreData, WorkspaceSettings } from './types';
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

  // Helper: immutably replace the custom field list
  const setCustomFields = useCallback((update: (fields: CustomField[]) => CustomField[]) => {
    setData((prev) => ({
      ...prev,
      settings: {
        ...(prev.settings || getDefaultSettings()),
        customFields: update(prev.settings?.customFields || []),
      },
    }));
  }, [setData]);

  // Create definition — optimistic insert, replace temp id with the
  // server-issued fieldId, roll back + toast on failure (incl. 409 dup key).
  const addCustomField = useCallback(async (field: Omit<CustomField, 'fieldId' | 'createdAt'>): Promise<string | null> => {
    const tempId = `temp-${crypto.randomUUID()}`;
    const optimistic: CustomField = {
      archived: false,
      sortOrder: 0,
      ...field,
      fieldId: tempId,
      createdAt: new Date().toISOString(),
    };
    setCustomFields((fields) => [...fields, optimistic]);

    try {
      const row = await api.customFields.create({
        name: field.name,
        key: field.key || undefined, // omit → server derives from name
        type: field.type,
        required: field.required,
        isUnique: field.isUnique,
        options: field.type === 'select' ? field.options : undefined,
        sortOrder: field.sortOrder ?? 0,
      }) as RawCustomFieldRow;
      const saved = mapApiCustomField(row);
      setCustomFields((fields) => fields.map((f) => (f.fieldId === tempId ? saved : f)));
      return null;
    } catch (err) {
      console.error('[API] Create custom field failed:', err);
      setCustomFields((fields) => fields.filter((f) => f.fieldId !== tempId));
      const apiErr = err as Partial<ApiError> | null;
      const message = apiErr?.status === 409
        ? (apiErr.message || `A field with key '${field.key}' already exists`)
        : apiErr?.message || 'Failed to create custom field. Please try again.';
      showToast(message, 'error');
      return message;
    }
  }, [setCustomFields]);

  // Update definition — key and type are immutable on the server, so only
  // the mutable properties are sent.
  const updateCustomField = useCallback(async (fieldId: string, patch: Partial<CustomField>): Promise<string | null> => {
    let snapshot: CustomField[] | undefined;
    setData((prev) => {
      snapshot = prev.settings?.customFields;
      return {
        ...prev,
        settings: {
          ...(prev.settings || getDefaultSettings()),
          customFields: (prev.settings?.customFields || []).map((f) =>
            f.fieldId === fieldId ? { ...f, ...patch, fieldId: f.fieldId, key: f.key, type: f.type } : f
          ),
        },
      };
    });

    try {
      const row = await api.customFields.update(fieldId, {
        name: patch.name,
        required: patch.required,
        isUnique: patch.isUnique,
        options: patch.options,
        archived: patch.archived,
        sortOrder: patch.sortOrder,
      }) as RawCustomFieldRow;
      const saved = mapApiCustomField(row);
      setCustomFields((fields) => fields.map((f) => (f.fieldId === fieldId ? saved : f)));
      return null;
    } catch (err) {
      console.error('[API] Update custom field failed:', err);
      const restore = snapshot;
      if (restore) {
        setCustomFields(() => restore);
      }
      const message = (err as Partial<ApiError> | null)?.message || 'Failed to save custom field — changes were reverted.';
      showToast(message, 'error');
      return message;
    }
  }, [setCustomFields, setData]);

  // Archive definition — DELETE never destroys (contact rows may carry
  // values). Locally the field is flagged archived so pickers exclude it.
  const deleteCustomField = useCallback(async (fieldId: string): Promise<string | null> => {
    let snapshot: CustomField[] | undefined;
    setData((prev) => {
      snapshot = prev.settings?.customFields;
      return {
        ...prev,
        settings: {
          ...(prev.settings || getDefaultSettings()),
          customFields: (prev.settings?.customFields || []).map((f) =>
            f.fieldId === fieldId ? { ...f, archived: true } : f
          ),
        },
      };
    });

    try {
      await api.customFields.archive(fieldId);
      return null;
    } catch (err) {
      console.error('[API] Archive custom field failed:', err);
      const restore = snapshot;
      if (restore) {
        setCustomFields(() => restore);
      }
      const message = (err as Partial<ApiError> | null)?.message || 'Failed to archive custom field — change was reverted.';
      showToast(message, 'error');
      return message;
    }
  }, [setCustomFields, setData]);

  return {
    updateSettings,
    addCustomField,
    updateCustomField,
    deleteCustomField,
  };
}
