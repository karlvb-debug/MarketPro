// ============================================
// API Data Mappers
// Transform between API (DB rows) ↔ Frontend (store types)
// ============================================

import type {
  Contact,
  ContactCompliance,
  Campaign,
  InboxMessage,
  EmailTemplate,
  SmsTemplate,
  VoiceScript,
  WebForm,
  Segment,
  SegmentFolder,
  TemplateFolder,
  WorkspaceSettings,
  CustomField,
} from './store';
import { defaultCompliance } from './store';

// ============================================
// API row types (what the backend returns)
// ============================================

export interface ApiContact {
  contact_id: string;
  workspace_id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  timezone: string | null;
  status: 'active' | 'unsubscribed' | 'bounced' | 'complained';
  source: string | null;
  consent_source: string | null;
  custom_fields: Record<string, string> | null;
  created_at: string;
  updated_at: string;
  // Joined from suppression_list queries
  suppressions?: { channel: string; reason: string; created_at: string }[];
}

export interface ApiCampaign {
  campaign_id: string;
  workspace_id: string;
  name: string;
  channel: 'email' | 'sms' | 'voice';
  template_id: string;
  segment_id: string;
  status: 'draft' | 'scheduled' | 'sending' | 'completed' | 'paused' | 'cancelled';
  scheduled_at: string | null;
  completed_at: string | null;
  total_recipients: number | null;
  estimated_cost: string | null;
  created_at: string;
  // Joined/aggregated
  segment_name?: string;
  template_name?: string;
  delivered?: number;
  opened?: number;
  clicked?: number;
  bounced?: number;
}

export interface ApiInboxSms {
  message_id: string;
  contact_id: string | null;
  from_number: string;
  body: string | null;
  is_keyword: boolean;
  keyword_type: string | null;
  received_at: string;
  read_at: string | null;
  contact_name?: string;
}

export interface ApiInboxEmail {
  message_id: string;
  contact_id: string | null;
  from_address: string;
  subject: string | null;
  body: string | null;
  received_at: string;
  read_at: string | null;
  contact_name?: string;
}

export interface ApiFormSubmission {
  submission_id: string;
  form_id: string;
  contact_id: string | null;
  form_data: Record<string, string>;
  ip_address: string | null;
  submitted_at: string;
  read_at: string | null;
  form_name?: string;
  contact_name?: string;
}

export interface ApiSegment {
  segment_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  folder_id: string | null;
  sort_order: number;
  color: string | null;
  created_at: string;
  contact_count?: number;
}

export interface ApiSettings {
  workspace_id: string;
  sms_sender_id: string | null;
  sms_phone_number: string | null;
  voice_phone_number: string | null;
  email_from_name: string | null;
  email_from_address: string | null;
  email_reply_to: string | null;
  timezone: string;
  business_name: string | null;
  business_address: string | null;
  business_city: string | null;
  business_state: string | null;
  business_zip: string | null;
  business_country: string;
  last_dnc_scrub_date: string | null;
  san_number: string | null;
}

// ============================================
// Mappers: API → Frontend
// ============================================

/** Map a DB contact row → frontend Contact with reconstructed compliance */
export function mapApiContact(row: ApiContact): Contact {
  const compliance = buildCompliance(row.status, row.suppressions);
  return {
    contactId: row.contact_id,
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    email: row.email || '',
    phone: row.phone || '',
    company: row.company || '',
    timezone: row.timezone || undefined,
    compliance,
    segments: [],  // Populated separately from contact_segment join
    source: row.source || '',
    consentSource: (row.consent_source as Contact['consentSource']) || undefined,
    customFields: row.custom_fields || undefined,
    createdAt: row.created_at,
  };
}

function buildCompliance(
  status: ApiContact['status'],
  suppressions?: { channel: string; reason: string; created_at: string }[],
): ContactCompliance {
  const comp = defaultCompliance();

  // Apply status-based suppression (legacy)
  if (status === 'unsubscribed') {
    comp.email = { suppressed: true, reason: 'unsubscribed', updatedAt: new Date().toISOString() };
  } else if (status === 'bounced') {
    comp.email = { suppressed: true, reason: 'bounced', updatedAt: new Date().toISOString() };
  } else if (status === 'complained') {
    comp.email = { suppressed: true, reason: 'complained', updatedAt: new Date().toISOString() };
  }

  // Apply per-channel suppressions if available
  if (suppressions) {
    for (const s of suppressions) {
      const channel = s.channel as 'email' | 'sms' | 'voice';
      if (comp[channel]) {
        comp[channel] = {
          suppressed: true,
          reason: mapSuppressionReason(s.reason),
          updatedAt: s.created_at,
        };
      }
    }
  }

  return comp;
}

function mapSuppressionReason(reason: string): Contact['compliance']['email']['reason'] {
  const map: Record<string, Contact['compliance']['email']['reason']> = {
    unsubscribe: 'unsubscribed',
    complaint: 'complained',
    bounce: 'bounced',
    gdpr_delete: 'dnc',
    manual: 'dnc',
  };
  return map[reason] || 'none';
}

/** Map a DB campaign row → frontend Campaign */
export function mapApiCampaign(row: ApiCampaign): Campaign {
  return {
    campaignId: row.campaign_id,
    name: row.name,
    channel: row.channel,
    status: row.status,
    segment: row.segment_name || '',
    templateId: row.template_id,
    templateName: row.template_name,
    scheduledAt: row.scheduled_at,
    totalRecipients: row.total_recipients || 0,
    delivered: row.delivered || 0,
    opened: row.opened ?? null,
    clicked: row.clicked ?? null,
    bounced: row.bounced || 0,
    createdAt: row.created_at,
  };
}

/** Map a DB SMS inbox row → frontend InboxMessage */
export function mapApiSmsInbox(row: ApiInboxSms): InboxMessage {
  return {
    messageId: row.message_id,
    channel: 'sms',
    fromNumber: row.from_number,
    contactName: row.contact_name || null,
    body: row.body || '',
    receivedAt: row.received_at,
    read: !!row.read_at,
    isKeyword: row.is_keyword,
  };
}

/** Map a DB email inbox row → frontend InboxMessage */
export function mapApiEmailInbox(row: ApiInboxEmail): InboxMessage {
  return {
    messageId: row.message_id,
    channel: 'email',
    fromNumber: '',
    fromAddress: row.from_address,
    contactName: row.contact_name || null,
    subject: row.subject || undefined,
    body: row.body || '',
    receivedAt: row.received_at,
    read: !!row.read_at,
  };
}

/** Map a DB form submission → frontend InboxMessage */
export function mapApiFormSubmission(row: ApiFormSubmission): InboxMessage {
  const formFields = Object.entries(row.form_data).map(([key, value]) => ({
    label: key,
    value: String(value),
  }));
  return {
    messageId: row.submission_id,
    channel: 'form',
    fromNumber: '',
    contactName: row.contact_name || null,
    body: Object.values(row.form_data).join(', '),
    receivedAt: row.submitted_at,
    read: !!row.read_at,
    formName: row.form_name,
    formFields,
  };
}

/** Map a DB segment row → frontend Segment */
export function mapApiSegment(row: ApiSegment): Segment {
  return {
    segmentId: row.segment_id,
    name: row.name,
    description: row.description || '',
    count: row.contact_count || 0,
    folder: row.folder_id || '',
    order: row.sort_order,
    color: row.color || undefined,
  };
}

/** Map a DB settings row → frontend WorkspaceSettings */
export function mapApiSettings(row: ApiSettings, customFields: CustomField[] = []): WorkspaceSettings {
  return {
    smsSenderId: row.sms_sender_id || '',
    smsPhoneNumber: row.sms_phone_number || '',
    voicePhoneNumber: row.voice_phone_number || '',
    emailFromName: row.email_from_name || '',
    emailFromAddress: row.email_from_address || '',
    emailReplyTo: row.email_reply_to || '',
    timezone: row.timezone || 'America/New_York',
    customFields,
    businessName: row.business_name || '',
    businessAddress: row.business_address || '',
    businessCity: row.business_city || '',
    businessState: row.business_state || '',
    businessZip: row.business_zip || '',
    businessCountry: row.business_country || 'US',
    lastDncScrubDate: row.last_dnc_scrub_date,
    sanNumber: row.san_number || '',
  };
}

// ============================================
// Mappers: Frontend → API (for create/update)
// ============================================

export function contactToApi(c: Omit<Contact, 'contactId' | 'createdAt' | 'compliance'>): Record<string, unknown> {
  return {
    email: c.email || null,
    phone: c.phone || null,
    first_name: c.firstName || null,
    last_name: c.lastName || null,
    company: c.company || null,
    timezone: c.timezone || null,
    source: c.source || 'manual',
    consent_source: c.consentSource || null,
    custom_fields: c.customFields || {},
  };
}

export function settingsToApi(s: Partial<WorkspaceSettings>): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  if (s.smsSenderId !== undefined) map.sms_sender_id = s.smsSenderId;
  if (s.smsPhoneNumber !== undefined) map.sms_phone_number = s.smsPhoneNumber;
  if (s.voicePhoneNumber !== undefined) map.voice_phone_number = s.voicePhoneNumber;
  if (s.emailFromName !== undefined) map.email_from_name = s.emailFromName;
  if (s.emailFromAddress !== undefined) map.email_from_address = s.emailFromAddress;
  if (s.emailReplyTo !== undefined) map.email_reply_to = s.emailReplyTo;
  if (s.timezone !== undefined) map.timezone = s.timezone;
  if (s.businessName !== undefined) map.business_name = s.businessName;
  if (s.businessAddress !== undefined) map.business_address = s.businessAddress;
  if (s.businessCity !== undefined) map.business_city = s.businessCity;
  if (s.businessState !== undefined) map.business_state = s.businessState;
  if (s.businessZip !== undefined) map.business_zip = s.businessZip;
  if (s.businessCountry !== undefined) map.business_country = s.businessCountry;
  if (s.lastDncScrubDate !== undefined) map.last_dnc_scrub_date = s.lastDncScrubDate;
  if (s.sanNumber !== undefined) map.san_number = s.sanNumber;
  return map;
}
