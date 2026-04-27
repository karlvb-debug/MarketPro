'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { mockContacts, mockSegments, mockCampaigns, mockTemplates, mockInbox, mockDashboardStats } from './mock-data';
import { config } from './config';
import { api, ApiError } from './api-client';
import { contactToApi, settingsToApi } from './api-mappers';

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

/** Create a clean, all-clear compliance object */
export function defaultCompliance(): ContactCompliance {
  const clear: ChannelStatus = { suppressed: false, reason: 'none', updatedAt: null };
  return { email: { ...clear }, sms: { ...clear }, voice: { ...clear } };
}

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
  compliance: ContactCompliance;
  segments: string[];
  source: string;
  /** How consent was obtained for imported contacts */
  consentSource?: 'collected_by_us' | 'partner_with_proof' | 'existing_customers' | 'purchased_list' | 'unknown';
  /** Audit trail of consent events */
  consentLog?: ConsentEvent[];
  customFields?: Record<string, string>;
  createdAt: string;
}

export interface Segment {
  segmentId: string;
  name: string;
  description: string;
  count: number;
  folder: string;     // folder name (empty = uncategorized)
  order: number;      // sort position
  color?: string;     // optional accent color
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
  design?: import('./email-templates').EmailDesign;
}

export interface TemplateFolder {
  folderId: string;
  name: string;
  order: number;
  isExpanded: boolean;
}

// ============================================
// Custom Fields & Workspace Settings
// ============================================

export interface CustomField {
  fieldId: string;
  name: string;        // Display label
  key: string;         // Slug for data storage
  type: 'text' | 'number' | 'date' | 'email' | 'phone' | 'url' | 'select';
  isUnique: boolean;   // Treat as unique identifier (like CRM ID)
  required: boolean;
  options?: string[];  // For 'select' type
  createdAt: string;
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

interface StoreData {
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
// Seed data — converted from mock-data.ts
// ============================================

function getDefaultSettings(): WorkspaceSettings {
  return {
    smsSenderId: '',
    smsPhoneNumber: '',
    voicePhoneNumber: '',
    emailFromName: '',
    emailFromAddress: '',
    emailReplyTo: '',
    timezone: 'America/New_York',
    customFields: [],
    // Compliance defaults
    businessName: '',
    businessAddress: '',
    businessCity: '',
    businessState: '',
    businessZip: '',
    businessCountry: 'US',
    lastDncScrubDate: null,
    sanNumber: '',
  };
}

function getSeedData(): StoreData {
  return {
    contacts: mockContacts.map((c) => {
      // Build compliance from legacy status field
      const comp = defaultCompliance();
      const status = c.status as string;
      if (status === 'unsubscribed') {
        comp.email = { suppressed: true, reason: 'unsubscribed', updatedAt: new Date().toISOString() };
      } else if (status === 'bounced') {
        comp.email = { suppressed: true, reason: 'bounced', updatedAt: new Date().toISOString() };
      } else if (status === 'complained') {
        comp.email = { suppressed: true, reason: 'complained', updatedAt: new Date().toISOString() };
      }
      // Apply any per-channel overrides from mock data
      if (c.compliance) {
        Object.assign(comp, c.compliance);
      }
      return {
        ...c,
        compliance: comp,
        createdAt: new Date().toISOString(),
      };
    }),
    segments: mockSegments.map((s, i) => ({ ...s, folder: '', order: i, color: undefined })),
    segmentFolders: [],
    campaigns: mockCampaigns.map((c) => ({
      ...c,
      createdAt: new Date().toISOString(),
    })),
    templates: {
      email: mockTemplates.email.map((t, i) => ({ ...t, folder: '', order: i })),
      sms: mockTemplates.sms.map((t, i) => ({ ...t, folder: '', order: i })),
      voice: mockTemplates.voice.map((t, i) => ({ ...t, folder: '', order: i })),
      webform: [],
    },
    templateFolders: [],
    inbox: mockInbox.map((m) => ({ ...m })),
    settings: getDefaultSettings(),
  };
}

// ============================================
// localStorage helpers (workspace-scoped)
// ============================================

import { useWorkspace, getDataKey } from './workspace';

function loadStore(workspaceId: string): StoreData {
  if (typeof window === 'undefined') return getSeedData();
  const key = getDataKey(workspaceId);
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as StoreData;
      // Migrate contacts: old `status` field → new `compliance` field
      if (parsed.contacts?.length && !parsed.contacts[0]!.compliance) {
        parsed.contacts = parsed.contacts.map((c: any) => {
          const comp = defaultCompliance();
          if (c.status === 'unsubscribed') {
            comp.email = { suppressed: true, reason: 'unsubscribed', updatedAt: c.createdAt };
          } else if (c.status === 'bounced') {
            comp.email = { suppressed: true, reason: 'bounced', updatedAt: c.createdAt };
          } else if (c.status === 'complained') {
            comp.email = { suppressed: true, reason: 'complained', updatedAt: c.createdAt };
          }
          return { ...c, compliance: comp };
        });
        // Persist migration
        localStorage.setItem(key, JSON.stringify(parsed));
      }
      // Migrate templates: ensure webform array exists
      if (!parsed.templates?.webform) {
        parsed.templates = { ...parsed.templates, webform: [] };
      }
      // Migrate: ensure templateFolders exists
      if (!parsed.templateFolders) {
        parsed.templateFolders = [];
      }
      // Migrate inbox: add channel field to old messages (default to sms)
      if (parsed.inbox?.length && !(parsed.inbox[0] as any).channel) {
        parsed.inbox = parsed.inbox.map((m: any) => ({ ...m, channel: 'sms' }));
      }
      return parsed;
    }
  } catch { /* ignore */ }
  const seed = getSeedData();
  localStorage.setItem(key, JSON.stringify(seed));
  return seed;
}

function saveStore(workspaceId: string, data: StoreData) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(getDataKey(workspaceId), JSON.stringify(data));
}

// ============================================
// API data loader — fetches all workspace data from backend
// ============================================

async function loadFromApi(): Promise<StoreData | null> {
  try {
    // Single API call — loads all workspace data from one Lambda
    const res = await api.batch.load() as any;
    if (!res) return null;

    const rawContacts = res.contacts || [];
    const contacts: Contact[] = rawContacts.map((row: any) => ({
      contactId: row.contactId || row.contact_id || crypto.randomUUID(),
      firstName: row.firstName || row.first_name || '',
      lastName: row.lastName || row.last_name || '',
      email: row.email || '',
      phone: row.phone || '',
      company: row.company || '',
      timezone: row.timezone || undefined,
      compliance: defaultCompliance(),
      segments: [],
      source: row.source || '',
      consentSource: row.consentSource || row.consent_source || undefined,
      customFields: row.customFields || row.custom_fields || undefined,
      createdAt: row.createdAt || row.created_at || new Date().toISOString(),
    }));

    const rawSegments = res.segments || [];
    const segments: Segment[] = rawSegments.map((row: any) => ({
      segmentId: row.segmentId || row.segment_id || crypto.randomUUID(),
      name: row.name || '',
      description: row.description || '',
      count: row.contactCount || row.contact_count || 0,
      folder: row.folderId || row.folder_id || '',
      order: row.sortOrder || row.sort_order || 0,
      color: row.color || undefined,
    }));

    const rawCampaigns = res.campaigns || [];
    const campaigns: Campaign[] = rawCampaigns.map((row: any) => ({
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

    const emailTemplates: EmailTemplate[] = (tpl.email || []).map((row: any) => ({
      templateId: row.templateId || row.template_id || crypto.randomUUID(),
      name: row.name || '',
      subjectLine: row.subjectLine || row.subject_line || '',
      updatedAt: row.updatedAt || row.updated_at || new Date().toISOString(),
      folder: row.folderId || row.folder_id || '',
      order: row.sortOrder || row.sort_order || 0,
    }));

    const smsTemplates: SmsTemplate[] = (tpl.sms || []).map((row: any) => ({
      templateId: row.templateId || row.template_id || crypto.randomUUID(),
      name: row.name || '',
      body: row.body || '',
      estimatedSegments: row.estimatedSegments || row.estimated_segments || 1,
      folder: row.folderId || row.folder_id || '',
      order: row.sortOrder || row.sort_order || 0,
    }));

    const voiceScripts: VoiceScript[] = (tpl.voice || []).map((row: any) => ({
      scriptId: row.scriptId || row.script_id || crypto.randomUUID(),
      name: row.name || '',
      voiceId: row.voiceId || row.voice_id || 'Joanna',
      updatedAt: row.updatedAt || row.updated_at || new Date().toISOString(),
      folder: row.folderId || row.folder_id || '',
      order: row.sortOrder || row.sort_order || 0,
    }));

    return {
      contacts,
      segments,
      segmentFolders: [],
      campaigns,
      templates: { email: emailTemplates, sms: smsTemplates, voice: voiceScripts, webform: [] },
      templateFolders: [],
      inbox: [],
      settings: getDefaultSettings(),
    };
  } catch {
    return null;
  }
}

// ============================================
// Main Store Hook (workspace-aware)
// ============================================

export function useStore() {
  const { activeWorkspace, hydrated: wsHydrated } = useWorkspace();
  const workspaceId = activeWorkspace.workspaceId;

  const [data, setData] = useState<StoreData>(getSeedData);
  const [hydrated, setHydrated] = useState(false);
  const useApi = config.isApiConfigured;

  // Reload data when workspace changes
  useEffect(() => {
    if (wsHydrated) {
      if (useApi) {
        // API mode — fetch from backend, fall back to localStorage on error
        loadFromApi().then((apiData) => {
          if (apiData) {
            setData(apiData);
          } else {
            setData(loadStore(workspaceId));
          }
          setHydrated(true);
        }).catch(() => {
          setData(loadStore(workspaceId));
          setHydrated(true);
        });
      } else {
        // Local mode — use localStorage
        setData(loadStore(workspaceId));
        setHydrated(true);
      }
    }
  }, [workspaceId, wsHydrated, useApi]);

  // Persist to localStorage (only when NOT using API)
  useEffect(() => {
    if (hydrated && !useApi) {
      saveStore(workspaceId, data);
    }
  }, [data, hydrated, workspaceId, useApi]);

  // Fire-and-forget API call helper (warns on errors, doesn't block UI)
  const apiCall = useCallback(async <T>(fn: () => Promise<T>): Promise<T | null> => {
    if (!useApi) return null;
    try {
      return await fn();
    } catch (err) {
      // Suppress noise — endpoints may not be deployed yet
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[API] Endpoint not available yet — mutation queued locally only`);
      }
      return null;
    }
  }, [useApi]);

  // ---- CONTACTS ----

  // Check for duplicate email/phone before adding — returns error string or null
  const addContact = useCallback((contact: Omit<Contact, 'contactId' | 'createdAt' | 'status' | 'compliance'>): string | null => {
    // Check against current data snapshot (synchronous)
    if (contact.email) {
      const emailMatch = data.contacts.find(
        (c) => c.email.toLowerCase() === contact.email.toLowerCase()
      );
      if (emailMatch) {
        return `A contact with email "${contact.email}" already exists (${emailMatch.firstName} ${emailMatch.lastName}).`;
      }
    }

    if (contact.phone) {
      const phoneNorm = contact.phone.replace(/\D/g, '');
      const phoneMatch = data.contacts.find(
        (c) => c.phone.replace(/\D/g, '') === phoneNorm
      );
      if (phoneMatch) {
        return `A contact with phone "${contact.phone}" already exists (${phoneMatch.firstName} ${phoneMatch.lastName}).`;
      }
    }

    const newContact: Contact = {
      ...contact,
      contactId: crypto.randomUUID(),
      compliance: defaultCompliance(),
      createdAt: new Date().toISOString(),
    };

    setData((prev) => {
      const updatedSegments = prev.segments.map((seg) => ({
        ...seg,
        count: contact.segments.includes(seg.name) ? seg.count + 1 : seg.count,
      }));
      return { ...prev, contacts: [newContact, ...prev.contacts], segments: updatedSegments };
    });

    // API: create contact
    apiCall(() => api.contacts.create(contactToApi(contact)));

    return null;
  }, [data.contacts, apiCall]);

  const updateContact = useCallback((contactId: string, patch: Partial<Omit<Contact, 'contactId' | 'createdAt'>>) => {
    setData((prev) => ({
      ...prev,
      contacts: prev.contacts.map((c) =>
        c.contactId === contactId ? { ...c, ...patch } : c
      ),
    }));
    // API: update contact
    apiCall(() => api.contacts.update(contactId, contactToApi(patch as any)));
  }, [apiCall]);

  const updateCompliance = useCallback((contactId: string, channel: 'email' | 'sms' | 'voice', reason: SuppressionReason, isDnc = false) => {
    setData((prev) => ({
      ...prev,
      contacts: prev.contacts.map((c) => {
        if (c.contactId !== contactId) return c;
        const compliance = { ...c.compliance };
        if (isDnc) {
          // DNC suppresses ALL channels
          const ts = new Date().toISOString();
          compliance.email = { suppressed: true, reason: 'dnc', updatedAt: ts };
          compliance.sms = { suppressed: true, reason: 'dnc', updatedAt: ts };
          compliance.voice = { suppressed: true, reason: 'dnc', updatedAt: ts };
        } else if (reason === 'none') {
          // Restoring a channel
          compliance[channel] = { suppressed: false, reason: 'none', updatedAt: new Date().toISOString() };
        } else {
          compliance[channel] = { suppressed: true, reason, updatedAt: new Date().toISOString() };
        }
        return { ...c, compliance };
      }),
    }));
  }, []);

  const deleteContact = useCallback((contactId: string) => {
    setData((prev) => ({
      ...prev,
      contacts: prev.contacts.filter((c) => c.contactId !== contactId),
    }));
    // API: delete contact
    apiCall(() => api.contacts.delete(contactId));
  }, [apiCall]);

  // Returns { added, skipped, blankSkipped } — skips contacts with duplicate email/phone and blank/unidentifiable rows
  const importContacts = useCallback((newContacts: Omit<Contact, 'contactId' | 'createdAt' | 'compliance'>[]): { added: number; updated: number; skipped: number; blankSkipped: number } => {
    let added = 0;
    let updated = 0;
    let skipped = 0;
    let blankSkipped = 0;

    setData((prev) => {
      // Clone existing contacts for mutation
      const updatedContacts = [...prev.contacts];

      // Build lookup maps: normalized value → index in updatedContacts
      const emailIndex = new Map<string, number>();
      const phoneIndex = new Map<string, number>();
      updatedContacts.forEach((c, idx) => {
        const email = c.email?.toLowerCase().trim();
        const phone = c.phone?.replace(/\D/g, '');
        if (email) emailIndex.set(email, idx);
        if (phone) phoneIndex.set(phone, idx);
      });

      // Also track emails/phones added within THIS import to avoid intra-batch dupes
      const batchEmails = new Set<string>();
      const batchPhones = new Set<string>();

      const created: Contact[] = [];

      for (const c of newContacts) {
        // Skip blank/unidentifiable contacts
        const hasEmail = c.email && c.email.trim();
        const hasPhone = c.phone && c.phone.trim();
        const hasName = (c.firstName && c.firstName.trim()) || (c.lastName && c.lastName.trim());
        if (!hasEmail && !hasPhone && !hasName) {
          blankSkipped++;
          continue;
        }

        const emailNorm = c.email?.toLowerCase().trim() || '';
        const phoneNorm = c.phone?.replace(/\D/g, '') || '';

        // Find an existing contact that matches by email OR phone
        let matchIdx = -1;
        if (emailNorm && emailIndex.has(emailNorm)) {
          matchIdx = emailIndex.get(emailNorm)!;
        } else if (phoneNorm && phoneIndex.has(phoneNorm)) {
          matchIdx = phoneIndex.get(phoneNorm)!;
        }

        if (matchIdx >= 0) {
          // UPDATE existing record — merge in new data (prefer non-empty values)
          const existing = updatedContacts[matchIdx]!;
          updatedContacts[matchIdx] = {
            ...existing,
            firstName: c.firstName?.trim() || existing.firstName,
            lastName: c.lastName?.trim() || existing.lastName,
            email: emailNorm || existing.email,
            phone: phoneNorm ? c.phone : existing.phone,
            company: c.company?.trim() || existing.company,
            timezone: c.timezone?.trim() || existing.timezone,
            segments: [...new Set([...existing.segments, ...(c.segments || [])])],
          };
          // Update indexes with the merged contact's values
          if (emailNorm) emailIndex.set(emailNorm, matchIdx);
          if (phoneNorm) phoneIndex.set(phoneNorm, matchIdx);
          updated++;
          continue;
        }

        // Check if this is a duplicate within the current batch
        if (emailNorm && batchEmails.has(emailNorm)) { skipped++; continue; }
        if (phoneNorm && batchPhones.has(phoneNorm)) { skipped++; continue; }

        // Track in batch dedup sets
        if (emailNorm) batchEmails.add(emailNorm);
        if (phoneNorm) batchPhones.add(phoneNorm);

        const newContact: Contact = {
          ...c,
          contactId: crypto.randomUUID(),
          compliance: defaultCompliance(),
          createdAt: new Date().toISOString(),
        };
        created.push(newContact);

        // Add to lookup maps so subsequent rows can match against this new contact
        const newIdx = updatedContacts.length + created.length - 1;
        if (emailNorm) emailIndex.set(emailNorm, newIdx);
        if (phoneNorm) phoneIndex.set(phoneNorm, newIdx);
        added++;
      }

      return { ...prev, contacts: [...created, ...updatedContacts] };
    });

    return { added, updated, skipped, blankSkipped };
  }, []);

  // ---- CAMPAIGNS ----

  const addCampaign = useCallback((campaign: {
    name: string;
    channel: 'email' | 'sms' | 'voice';
    segment: string;
    templateId?: string;
    templateName?: string;
    scheduledAt: string | null;
  }) => {
    setData((prev) => {
      // Find segment to get recipient count
      const seg = prev.segments.find((s) => s.name === campaign.segment);
      const newCampaign: Campaign = {
        campaignId: crypto.randomUUID(),
        name: campaign.name,
        channel: campaign.channel,
        status: campaign.scheduledAt ? 'scheduled' : 'draft',
        segment: campaign.segment,
        templateId: campaign.templateId,
        templateName: campaign.templateName,
        scheduledAt: campaign.scheduledAt,
        totalRecipients: seg?.count || 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
        createdAt: new Date().toISOString(),
      };
      return { ...prev, campaigns: [newCampaign, ...prev.campaigns] };
    });
    // API: create campaign
    apiCall(() => api.campaigns.create({
      name: campaign.name,
      channel: campaign.channel,
      segment_id: campaign.segment,
      template_id: campaign.templateId,
      scheduled_at: campaign.scheduledAt,
    }));
  }, [apiCall]);

  // ---- INBOX ----

  const markRead = useCallback((messageId: string) => {
    setData((prev) => ({
      ...prev,
      inbox: prev.inbox.map((m) =>
        m.messageId === messageId ? { ...m, read: true } : m
      ),
    }));
    // API: mark read
    apiCall(() => api.inbox.markRead(messageId));
  }, [apiCall]);

  // ---- SEGMENTS ----

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
  }, [apiCall]);

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
  }, [apiCall]);

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
  }, []);

  const addContactsToSegment = useCallback((contactIds: string[], segmentName: string) => {
    setData((prev) => {
      const updatedContacts = prev.contacts.map((c) => {
        if (contactIds.includes(c.contactId) && !c.segments.includes(segmentName)) {
          return { ...c, segments: [...c.segments, segmentName] };
        }
        return c;
      });
      return { ...prev, contacts: updatedContacts };
    });
  }, []);

  const removeContactsFromSegment = useCallback((contactIds: string[], segmentName: string) => {
    setData((prev) => {
      const updatedContacts = prev.contacts.map((c) => {
        if (contactIds.includes(c.contactId)) {
          return { ...c, segments: c.segments.filter((s) => s !== segmentName) };
        }
        return c;
      });
      return { ...prev, contacts: updatedContacts };
    });
  }, []);

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
  }, []);

  const reorderSegments = useCallback((orderedIds: string[]) => {
    setData((prev) => ({
      ...prev,
      segments: prev.segments.map((s) => {
        const idx = orderedIds.indexOf(s.segmentId);
        return idx >= 0 ? { ...s, order: idx } : s;
      }),
    }));
  }, []);

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
  }, []);

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
  }, []);

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
  }, []);

  const toggleFolderExpanded = useCallback((folderId: string) => {
    setData((prev) => ({
      ...prev,
      segmentFolders: (prev.segmentFolders || []).map((f) =>
        f.folderId === folderId ? { ...f, isExpanded: !f.isExpanded } : f
      ),
    }));
  }, []);

  // Recompute segment counts from actual contact data
  const segments = data.segments.map((seg) => ({
    ...seg,
    count: data.contacts.filter((c) => c.segments.includes(seg.name)).length,
  }));

  // ---- TEMPLATES ----

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
  }, [apiCall]);

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
  }, [apiCall]);

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
  }, []);

  const deleteTemplate = useCallback((templateId: string, type: 'email' | 'sms' | 'voice' | 'webform') => {
    setData((prev) => ({
      ...prev,
      templates: {
        ...prev.templates,
        [type]: (prev.templates[type] as any[]).filter((t: any) => (t.templateId || t.scriptId || t.formId) !== templateId),
      },
    }));
    // API: delete template
    const apiType = type === 'webform' ? null : type; // webforms not wired yet
    if (apiType) {
      apiCall(() => api.templates[apiType].delete(templateId));
    }
  }, [apiCall]);

  const renameTemplate = useCallback((templateId: string, type: 'email' | 'sms' | 'voice' | 'webform', newName: string) => {
    setData((prev) => ({
      ...prev,
      templates: {
        ...prev.templates,
        [type]: (prev.templates[type] as any[]).map((t: any) =>
          (t.templateId || t.scriptId || t.formId) === templateId ? { ...t, name: newName } : t
        ),
      },
    }));
    // API: rename template
    const apiType = type === 'webform' ? null : type;
    if (apiType) {
      apiCall(() => api.templates[apiType].update(templateId, { name: newName }));
    }
  }, [apiCall]);

  const moveTemplateToFolder = useCallback((templateId: string, type: 'email' | 'sms' | 'voice' | 'webform', folderName: string) => {
    setData((prev) => ({
      ...prev,
      templates: {
        ...prev.templates,
        [type]: (prev.templates[type] as any[]).map((t: any) =>
          (t.templateId || t.scriptId || t.formId) === templateId ? { ...t, folder: folderName } : t
        ),
      },
    }));
  }, []);

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
  }, []);

  const deleteTemplateFolder = useCallback((folderId: string) => {
    setData((prev) => {
      const folders = prev.templateFolders || [];
      const folder = folders.find((f) => f.folderId === folderId);
      if (!folder) return prev;
      const clearFolder = (arr: any[]) => arr.map((t: any) => t.folder === folder.name ? { ...t, folder: '' } : t);
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
  }, []);

  const toggleTemplateFolderExpanded = useCallback((folderId: string) => {
    setData((prev) => ({
      ...prev,
      templateFolders: (prev.templateFolders || []).map((f) =>
        f.folderId === folderId ? { ...f, isExpanded: !f.isExpanded } : f
      ),
    }));
  }, []);

  // ---- SETTINGS & CUSTOM FIELDS ----

  // Ensure settings always has defaults (for stores created before settings existed)
  const settings: WorkspaceSettings = data.settings || getDefaultSettings();

  const updateSettings = useCallback((patch: Partial<WorkspaceSettings>) => {
    setData((prev) => ({
      ...prev,
      settings: { ...(prev.settings || getDefaultSettings()), ...patch },
    }));
    // API: update settings
    apiCall(() => api.settings.update(settingsToApi(patch)));
  }, [apiCall]);

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
  }, []);

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
  }, []);

  const deleteCustomField = useCallback((fieldId: string) => {
    setData((prev) => ({
      ...prev,
      settings: {
        ...(prev.settings || getDefaultSettings()),
        customFields: (prev.settings?.customFields || []).filter((f) => f.fieldId !== fieldId),
      },
    }));
  }, []);

  // ---- COMPUTED STATS ----

  const stats = {
    totalContacts: data.contacts.length,
    contactsChange: '',
    activeCampaigns: data.campaigns.filter((c) => ['sending', 'scheduled'].includes(c.status)).length,
    campaignsChange: '',
    messagesSent: data.campaigns.reduce((sum, c) => sum + c.delivered, 0),
    messagesChange: '',
    unreadInbox: data.inbox.filter((m) => !m.read).length,
    inboxChange: '',
  };

  // ---- RESET ----

  const resetData = useCallback(() => {
    const seed = getSeedData();
    setData(seed);
    saveStore(workspaceId, seed);
  }, [workspaceId]);

  return {
    ...data,
    segments,
    settings,
    stats,
    hydrated,
    addContact,
    updateContact,
    updateCompliance,
    deleteContact,
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
  };
}
