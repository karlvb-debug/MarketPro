// ============================================
// Types matching the database schema
// ============================================

export type SuppressionReason =
  | 'none'          // No suppression — can send
  | 'unsubscribed'  // User opted out via preference
  | 'stop'          // Replied STOP (SMS/Voice)
  | 'bounced'       // Hard bounce (Email)
  | 'complained'    // Marked as spam (Email)
  | 'dnc'           // Do Not Contact (global legal block)
  | 'invalid';      // Invalid address/number

export interface ChannelStatus {
  suppressed: boolean;
  reason: SuppressionReason;
  updatedAt: string | null;
}

export interface ContactCompliance {
  email: ChannelStatus;
  sms: ChannelStatus;
  voice: ChannelStatus;
}

/** Consent audit trail entry — kept for 5 years per TSR mandate */
export interface ConsentEvent {
  eventId: string;
  channel: 'email' | 'sms' | 'voice';
  action: 'opted_in' | 'opted_out' | 'suppressed' | 'reactivated';
  timestamp: string;
  source: 'webform' | 'import' | 'manual' | 'api' | 'keyword';
  ip?: string;
  formId?: string;
  evidence?: string;
}

export type OverallStatus = 'active' | 'dnc' | 'partial' | 'suppressed';

/** Compute the overall contact status from per-channel compliance */
export function getOverallStatus(c: ContactCompliance): OverallStatus {
  const channels = [c.email, c.sms, c.voice];
  if (channels.some((ch) => ch.reason === 'dnc')) return 'dnc';
  const suppressedCount = channels.filter((ch) => ch.suppressed).length;
  if (suppressedCount === 0) return 'active';
  if (suppressedCount === 3) return 'suppressed';
  return 'partial';
}

export interface Contact {
  contactId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  timezone?: string;
  /** US state or province — used for state-specific compliance logic (EBR windows, calling hours, etc.) */
  state?: string;
  compliance: ContactCompliance;
  segments: string[];
  source: string;
  /** How consent was obtained for imported contacts */
  consentSource?: 'collected_by_us' | 'partner_with_proof' | 'existing_customers' | 'purchased_list' | 'unknown';
  /** Audit trail of consent events */
  consentLog?: ConsentEvent[];
  customFields?: Record<string, string>;
  createdAt: string;
  /** Engagement rollups (from the contact list/search rows). Default 0 / null for older rows. */
  totalSent: number;
  totalDelivered: number;
  totalOpened: number;
  totalClicked: number;
  lastSentAt: string | null;
  lastEngagedAt: string | null;
}

export interface Segment {
  segmentId: string;
  name: string;
  description: string;
  count: number;
  folder: string;     // folder name (empty = uncategorized)
  order: number;      // sort position
  color?: string;     // optional accent color
  /** 'static' = explicit contact_segment rows; 'dynamic' = rule-based (Smart segment) */
  kind: 'static' | 'dynamic';
  /** Rule AST for dynamic segments (null for static) */
  rules: RuleGroup | null;
  /** Last computed membership count for dynamic segments (null for static) */
  cachedCount: number | null;
  /** ISO timestamp of the last cachedCount refresh (null when never computed) */
  countRefreshedAt: string | null;
}

export interface SegmentFolder {
  folderId: string;
  name: string;
  order: number;
  isExpanded: boolean;
}

export interface Campaign {
  campaignId: string;
  name: string;
  channel: 'email' | 'sms' | 'voice';
  status: 'draft' | 'scheduled' | 'sending' | 'completed' | 'paused' | 'cancelled';
  segment: string;
  templateId?: string;
  templateName?: string;
  scheduledAt: string | null;
  totalRecipients: number;
  delivered: number;
  opened: number | null;
  clicked: number | null;
  bounced: number;
  createdAt: string;
}

export interface InboxMessage {
  messageId: string;
  channel: 'sms' | 'email' | 'form';
  fromNumber: string;
  contactName: string | null;
  body: string;
  receivedAt: string;
  read: boolean;
  isKeyword?: boolean;
  // Email-specific
  subject?: string;
  fromAddress?: string;
  // Form-specific
  formName?: string;
  formFields?: { label: string; value: string }[];
}

export interface EmailTemplate {
  templateId: string;
  name: string;
  subjectLine: string;
  /** Compiled HTML that dispatch sends. */
  htmlContent?: string;
  /** Block-editor design — source of truth for re-editing in the builder. */
  editorJson?: import('../email-templates').EmailDesign | null;
  updatedAt: string;
  folder?: string;
  order: number;
}

export interface SmsTemplate {
  templateId: string;
  name: string;
  body: string;
  estimatedSegments: number;
  folder?: string;
  order: number;
}

export interface VoiceScript {
  scriptId: string;
  name: string;
  voiceId: string;
  updatedAt: string;
  folder?: string;
  order: number;
}

export interface WebFormField {
  fieldId: string;
  label: string;
  type: 'text' | 'email' | 'phone' | 'textarea' | 'select' | 'checkbox';
  required: boolean;
  placeholder?: string;
  options?: string[];
}

export interface WebForm {
  formId: string;
  name: string;
  description: string;
  fields: WebFormField[];
  submitLabel: string;
  successMessage: string;
  updatedAt: string;
  folder?: string;
  order: number;
  /** Block-based form design from the builder */
  design?: import('../email-templates').EmailDesign;
}

export interface TemplateFolder {
  folderId: string;
  name: string;
  order: number;
  isExpanded: boolean;
}

/** Any of the four template/content record types */
export type AnyTemplate = EmailTemplate | SmsTemplate | VoiceScript | WebForm;

/** Get the canonical record ID regardless of template type */
export function templateRecordId(t: AnyTemplate): string {
  if ('scriptId' in t) return t.scriptId;
  if ('formId' in t) return t.formId;
  return t.templateId;
}

// ============================================
// Custom Fields & Workspace Settings
// ============================================

export interface CustomField {
  fieldId: string;
  name: string;        // Display label
  key: string;         // Slug for data storage (immutable after creation)
  type: 'text' | 'number' | 'date' | 'email' | 'phone' | 'url' | 'select'; // immutable after creation
  isUnique: boolean;   // Treat as unique identifier (like CRM ID)
  required: boolean;
  options?: string[];  // For 'select' type
  /** Archived definitions are kept (contact rows may carry values) but hidden from pickers */
  archived?: boolean;
  sortOrder?: number;
  createdAt: string;
}

// ============================================
// Contact filter rules — mirrors lambda/lib/rules.ts (POST /contacts/search)
// ============================================

export type RuleOp =
  | 'eq' | 'neq'
  | 'contains' | 'starts_with' | 'ends_with'
  | 'is_set' | 'not_set'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'within_days'
  | 'in' | 'not_in';

export interface RuleCondition {
  field: string;
  op: RuleOp;
  value?: unknown;
}

export interface RuleGroup {
  combinator: 'and' | 'or';
  conditions: (RuleCondition | RuleGroup)[];
}

export interface WorkspaceSettings {
  // Channel configuration
  smsSenderId: string;
  smsPhoneNumber: string;
  voicePhoneNumber: string;
  emailFromName: string;
  emailFromAddress: string;
  emailReplyTo: string;
  // General
  timezone: string;
  // Custom contact fields
  customFields: CustomField[];
  // Compliance
  businessName: string;
  businessAddress: string;
  businessCity: string;
  businessState: string;
  businessZip: string;
  businessCountry: string;
  lastDncScrubDate: string | null;
  sanNumber: string;
}

export interface StoreData {
  contacts: Contact[];
  segments: Segment[];
  segmentFolders: SegmentFolder[];
  campaigns: Campaign[];
  templates: {
    email: EmailTemplate[];
    sms: SmsTemplate[];
    voice: VoiceScript[];
    webform: WebForm[];
  };
  templateFolders: TemplateFolder[];
  inbox: InboxMessage[];
  settings: WorkspaceSettings;
}

// ============================================
// Raw API row shapes — the backend may return camelCase or snake_case keys,
// and any field may be missing, so everything is optional.
// ============================================

export interface RawSegmentRow {
  segmentId?: string; segment_id?: string;
  name?: string;
  description?: string;
  contactCount?: number; contact_count?: number;
  folderId?: string; folder_id?: string;
  sortOrder?: number; sort_order?: number;
  color?: string;
  kind?: 'static' | 'dynamic';
  rules?: RuleGroup | null;
  cachedCount?: number | null; cached_count?: number | null;
  countRefreshedAt?: string | null; count_refreshed_at?: string | null;
}

export interface RawCampaignRow {
  campaignId?: string; campaign_id?: string;
  name?: string;
  channel?: Campaign['channel'];
  status?: Campaign['status'];
  segmentName?: string; segment_name?: string;
  templateId?: string; template_id?: string;
  templateName?: string; template_name?: string;
  scheduledAt?: string | null; scheduled_at?: string | null;
  totalRecipients?: number; total_recipients?: number;
  delivered?: number;
  opened?: number | null;
  clicked?: number | null;
  bounced?: number;
  createdAt?: string; created_at?: string;
}

export interface RawEmailTemplateRow {
  templateId?: string; template_id?: string;
  name?: string;
  subjectLine?: string; subject_line?: string;
  htmlContent?: string; html_content?: string;
  editorJson?: unknown; editor_json?: unknown;
  updatedAt?: string; updated_at?: string;
  folderId?: string; folder_id?: string;
  sortOrder?: number; sort_order?: number;
}

export interface RawSmsTemplateRow {
  templateId?: string; template_id?: string;
  name?: string;
  body?: string;
  estimatedSegments?: number; estimated_segments?: number;
  folderId?: string; folder_id?: string;
  sortOrder?: number; sort_order?: number;
}

export interface RawVoiceScriptRow {
  scriptId?: string; script_id?: string;
  name?: string;
  voiceId?: string; voice_id?: string;
  updatedAt?: string; updated_at?: string;
  folderId?: string; folder_id?: string;
  sortOrder?: number; sort_order?: number;
}

export interface RawContactRow {
  contactId?: string; contact_id?: string;
  firstName?: string; first_name?: string;
  lastName?: string; last_name?: string;
  email?: string;
  phone?: string;
  company?: string;
  timezone?: string;
  state?: string;
  status?: string;
  segments?: string[];
  source?: string;
  consentSource?: Contact['consentSource']; consent_source?: Contact['consentSource'];
  customFields?: Record<string, string>; custom_fields?: Record<string, string>;
  createdAt?: string; created_at?: string;
  updatedAt?: string; updated_at?: string;
  // Engagement rollups (camelCase or snake_case; any may be missing on older rows)
  totalSent?: number; total_sent?: number;
  totalDelivered?: number; total_delivered?: number;
  totalOpened?: number; total_opened?: number;
  totalClicked?: number; total_clicked?: number;
  lastSentAt?: string | null; last_sent_at?: string | null;
  lastEngagedAt?: string | null; last_engaged_at?: string | null;
}

export interface RawCustomFieldRow {
  fieldId?: string; field_id?: string;
  name?: string;
  key?: string;
  type?: CustomField['type'];
  required?: boolean;
  isUnique?: boolean; is_unique?: boolean;
  options?: string[] | null;
  archived?: boolean;
  sortOrder?: number; sort_order?: number;
  createdAt?: string; created_at?: string;
}

export interface BatchLoadResponse {
  segments?: RawSegmentRow[];
  campaigns?: RawCampaignRow[];
  templates?: {
    email?: RawEmailTemplateRow[];
    sms?: RawSmsTemplateRow[];
    voice?: RawVoiceScriptRow[];
  };
}

// ============================================
// Per-contact timeline + consent contracts
// (GET /contacts/{id}/timeline, GET /contacts/{id}/consent)
// ============================================

export type TimelineEventType = 'message' | 'consent' | 'inbound_sms' | 'inbound_email';

export interface TimelineEvent {
  type: TimelineEventType;
  at: string;
  // message
  channel?: string;
  status?: string;
  campaignName?: string | null;
  cost?: string | null;
  // consent
  consentType?: 'opt_in' | 'opt_out' | string;
  consentChannel?: string;
  source?: string | null;
  // inbound_sms / inbound_email
  body?: string | null;
  fromAddress?: string | null;
}

export interface TimelineResponse {
  data?: TimelineEvent[];
  meta?: {
    nextCursor?: string | null;
    hasMore?: boolean;
  };
}

export interface ConsentChannelState {
  suppressed: boolean;
  reason: string | null;
}

export interface ConsentLedgerEntry {
  consentType: string;
  channel: string;
  source: string | null;
  at: string;
}

export interface ConsentStateResponse {
  email: ConsentChannelState;
  phone: ConsentChannelState;
  ledger: ConsentLedgerEntry[];
}

export interface ContactsListResponse {
  data?: RawContactRow[];
  meta?: {
    total?: number;
    pageSize?: number;
    nextCursor?: string | null;
    hasMore?: boolean;
  };
}

// ============================================
// Shared dependencies passed to the domain slice hooks
// ============================================

import type { Dispatch, SetStateAction } from 'react';

export type SetStoreData = Dispatch<SetStateAction<StoreData>>;

/** Fire-and-forget API call helper shape (defined in index.ts) */
export type ApiCallFn = <T>(fn: () => Promise<T>) => Promise<T | null>;
