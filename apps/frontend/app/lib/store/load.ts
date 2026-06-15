// ============================================
// API data loader — fetches all workspace data from backend
// ============================================

import { api } from '../api-client';
import { mapApiCustomField, mapRawSegment } from '../api-mappers';
import type {
  BatchLoadResponse,
  Campaign,
  CustomField,
  EmailTemplate,
  RawCustomFieldRow,
  Segment,
  SmsTemplate,
  StoreData,
  VoiceScript,
} from './types';
import { getDefaultSettings } from './seed';

export async function loadFromApi(): Promise<StoreData | null> {
  try {
    // Batch call loads all workspace data from one Lambda; custom field
    // definitions live behind their own endpoint, fetched in parallel.
    const [res, customFieldsRes] = await Promise.all([
      api.batch.load() as Promise<BatchLoadResponse | null>,
      api.customFields.list().catch((err) => {
        console.error('loadFromApi custom fields error:', err);
        return null;
      }),
    ]);
    if (!res) return null;

    const customFields: CustomField[] = ((customFieldsRes?.data || []) as RawCustomFieldRow[])
      .map(mapApiCustomField);

    const rawSegments = res.segments || [];
    const segments: Segment[] = rawSegments.map(mapRawSegment);

    const rawCampaigns = res.campaigns || [];
    const campaigns: Campaign[] = rawCampaigns.map((row) => ({
      campaignId: row.campaignId || row.campaign_id || crypto.randomUUID(),
      name: row.name || '',
      channel: row.channel || 'email',
      status: row.status || 'draft',
      segment: row.segmentName || row.segment_name || '',
      templateId: row.templateId || row.template_id || '',
      templateName: row.templateName || row.template_name || undefined,
      scheduledAt: row.scheduledAt || row.scheduled_at || null,
      totalRecipients: row.totalRecipients || row.total_recipients || 0,
      delivered: row.delivered || 0,
      opened: row.opened ?? null,
      clicked: row.clicked ?? null,
      bounced: row.bounced || 0,
      createdAt: row.createdAt || row.created_at || new Date().toISOString(),
    }));

    const tpl = res.templates || {};

    const emailTemplates: EmailTemplate[] = (tpl.email || []).map((row) => ({
      templateId: row.templateId || row.template_id || crypto.randomUUID(),
      name: row.name || '',
      subjectLine: row.subjectLine || row.subject_line || '',
      updatedAt: row.updatedAt || row.updated_at || new Date().toISOString(),
      folder: row.folderId || row.folder_id || '',
      order: row.sortOrder || row.sort_order || 0,
    }));

    const smsTemplates: SmsTemplate[] = (tpl.sms || []).map((row) => ({
      templateId: row.templateId || row.template_id || crypto.randomUUID(),
      name: row.name || '',
      body: row.body || '',
      estimatedSegments: row.estimatedSegments || row.estimated_segments || 1,
      folder: row.folderId || row.folder_id || '',
      order: row.sortOrder || row.sort_order || 0,
    }));

    const voiceScripts: VoiceScript[] = (tpl.voice || []).map((row) => ({
      scriptId: row.scriptId || row.script_id || crypto.randomUUID(),
      name: row.name || '',
      voiceId: row.voiceId || row.voice_id || 'Joanna',
      updatedAt: row.updatedAt || row.updated_at || new Date().toISOString(),
      folder: row.folderId || row.folder_id || '',
      order: row.sortOrder || row.sort_order || 0,
    }));

    return {
      contacts: [],
      segments,
      segmentFolders: [],
      campaigns,
      templates: { email: emailTemplates, sms: smsTemplates, voice: voiceScripts, webform: [] },
      templateFolders: [],
      inbox: [],
      settings: { ...getDefaultSettings(), customFields },
    };
  } catch (err) {
    console.error('loadFromApi error:', err);
    return null;
  }
}
