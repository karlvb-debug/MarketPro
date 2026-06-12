'use client';

// ============================================
// Templates domain slice — email/sms/voice/webform templates
// and template folders.
// ============================================

import { useCallback } from 'react';
import { api } from '../api-client';
import type { AnyTemplate, ApiCallFn, SetStoreData, StoreData } from './types';
import { templateRecordId } from './types';

interface TemplatesSliceDeps {
  setData: SetStoreData;
  apiCall: ApiCallFn;
}

export function useTemplatesSlice({ setData, apiCall }: TemplatesSliceDeps) {
  const addEmailTemplate = useCallback((template: { name: string; subjectLine: string }) => {
    const templateId = crypto.randomUUID();
    setData((prev) => {
      const maxOrder = prev.templates.email.reduce((m, t) => Math.max(m, t.order), -1);
      return {
        ...prev,
        templates: {
          ...prev.templates,
          email: [...prev.templates.email, {
            templateId,
            name: template.name,
            subjectLine: template.subjectLine,
            updatedAt: new Date().toISOString(),
            folder: '',
            order: maxOrder + 1,
          }],
        },
      };
    });
    // API: create email template
    apiCall(() => api.templates.email.create({
      name: template.name,
      subject_line: template.subjectLine,
    }));
  }, [apiCall, setData]);

  const addSmsTemplate = useCallback((template: { name: string; body: string }) => {
    setData((prev) => {
      const maxOrder = prev.templates.sms.reduce((m, t) => Math.max(m, t.order), -1);
      return {
        ...prev,
        templates: {
          ...prev.templates,
          sms: [...prev.templates.sms, {
            templateId: crypto.randomUUID(),
            name: template.name,
            body: template.body,
            estimatedSegments: Math.ceil(template.body.length / 160),
            folder: '',
            order: maxOrder + 1,
          }],
        },
      };
    });
    // API: create sms template
    apiCall(() => api.templates.sms.create({
      name: template.name,
      body: template.body,
      estimated_segments: Math.ceil(template.body.length / 160),
    }));
  }, [apiCall, setData]);

  const addVoiceTemplate = useCallback((template: { name: string; ssmlContent: string; voiceId?: string }) => {
    setData((prev) => {
      const maxOrder = prev.templates.voice.reduce((m, t) => Math.max(m, t.order || 0), -1);
      return {
        ...prev,
        templates: {
          ...prev.templates,
          voice: [...prev.templates.voice, {
            scriptId: crypto.randomUUID(),
            name: template.name,
            ssmlContent: template.ssmlContent,
            voiceId: template.voiceId || 'Joanna',
            folder: '',
            order: maxOrder + 1,
            updatedAt: new Date().toISOString(),
          }],
        },
      };
    });
    // API: create voice template
    apiCall(() => api.templates.voice.create({
      name: template.name,
      ssml_content: template.ssmlContent,
      voice_id: template.voiceId || 'Joanna',
    }));
  }, [apiCall, setData]);

  const addWebForm = useCallback((form: { name: string; description: string }) => {
    setData((prev) => {
      const maxOrder = prev.templates.webform.reduce((m, t) => Math.max(m, t.order), -1);
      return {
        ...prev,
        templates: {
          ...prev.templates,
          webform: [...prev.templates.webform, {
            formId: crypto.randomUUID(),
            name: form.name,
            description: form.description,
            fields: [
              { fieldId: crypto.randomUUID(), label: 'Name', type: 'text' as const, required: true, placeholder: 'Your name' },
              { fieldId: crypto.randomUUID(), label: 'Email', type: 'email' as const, required: true, placeholder: 'you@example.com' },
              { fieldId: crypto.randomUUID(), label: 'Message', type: 'textarea' as const, required: false, placeholder: 'How can we help?' },
            ],
            submitLabel: 'Submit',
            successMessage: 'Thanks! We\'ll be in touch.',
            updatedAt: new Date().toISOString(),
            folder: '',
            order: maxOrder + 1,
          }],
        },
      };
    });
    // Note: webforms don't have a backend handler yet
  }, [setData]);

  const deleteTemplate = useCallback((templateId: string, type: 'email' | 'sms' | 'voice' | 'webform') => {
    setData((prev) => ({
      ...prev,
      templates: {
        ...prev.templates,
        [type]: (prev.templates[type] as AnyTemplate[]).filter((t) => templateRecordId(t) !== templateId),
      } as StoreData['templates'],
    }));
    // API: delete template
    const apiType = type === 'webform' ? null : type; // webforms not wired yet
    if (apiType) {
      apiCall(() => api.templates[apiType].delete(templateId));
    }
  }, [apiCall, setData]);

  const renameTemplate = useCallback((templateId: string, type: 'email' | 'sms' | 'voice' | 'webform', newName: string) => {
    setData((prev) => ({
      ...prev,
      templates: {
        ...prev.templates,
        [type]: (prev.templates[type] as AnyTemplate[]).map((t) =>
          templateRecordId(t) === templateId ? { ...t, name: newName } : t
        ),
      } as StoreData['templates'],
    }));
    // API: rename template
    const apiType = type === 'webform' ? null : type;
    if (apiType) {
      apiCall(() => api.templates[apiType].update(templateId, { name: newName }));
    }
  }, [apiCall, setData]);

  const moveTemplateToFolder = useCallback((templateId: string, type: 'email' | 'sms' | 'voice' | 'webform', folderName: string) => {
    setData((prev) => ({
      ...prev,
      templates: {
        ...prev.templates,
        [type]: (prev.templates[type] as AnyTemplate[]).map((t) =>
          templateRecordId(t) === templateId ? { ...t, folder: folderName } : t
        ),
      } as StoreData['templates'],
    }));
  }, [setData]);

  // Template folders
  const addTemplateFolder = useCallback((name: string) => {
    setData((prev) => {
      const folders = prev.templateFolders || [];
      const maxOrder = folders.reduce((max, f) => Math.max(max, f.order), -1);
      return {
        ...prev,
        templateFolders: [...folders, {
          folderId: crypto.randomUUID(),
          name,
          order: maxOrder + 1,
          isExpanded: true,
        }],
      };
    });
  }, [setData]);

  const deleteTemplateFolder = useCallback((folderId: string) => {
    setData((prev) => {
      const folders = prev.templateFolders || [];
      const folder = folders.find((f) => f.folderId === folderId);
      if (!folder) return prev;
      const clearFolder = <T extends { folder?: string }>(arr: T[]): T[] =>
        arr.map((t) => t.folder === folder.name ? { ...t, folder: '' } : t);
      return {
        ...prev,
        templateFolders: folders.filter((f) => f.folderId !== folderId),
        templates: {
          email: clearFolder(prev.templates.email),
          sms: clearFolder(prev.templates.sms),
          voice: clearFolder(prev.templates.voice),
          webform: clearFolder(prev.templates.webform),
        },
      };
    });
  }, [setData]);

  const toggleTemplateFolderExpanded = useCallback((folderId: string) => {
    setData((prev) => ({
      ...prev,
      templateFolders: (prev.templateFolders || []).map((f) =>
        f.folderId === folderId ? { ...f, isExpanded: !f.isExpanded } : f
      ),
    }));
  }, [setData]);

  return {
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
  };
}
