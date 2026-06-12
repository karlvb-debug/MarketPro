// ============================================
// Seed / default data — converted from mock-data.ts
// ============================================

import type { ChannelStatus, ContactCompliance, StoreData, WorkspaceSettings } from './types';

/** Create a clean, all-clear compliance object */
export function defaultCompliance(): ContactCompliance {
  const clear: ChannelStatus = { suppressed: false, reason: 'none', updatedAt: null };
  return { email: { ...clear }, sms: { ...clear }, voice: { ...clear } };
}

export function getDefaultSettings(): WorkspaceSettings {
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

export function getEmptyData(): StoreData {
  return {
    contacts: [],
    segments: [],
    segmentFolders: [],
    campaigns: [],
    templates: { email: [], sms: [], voice: [], webform: [] },
    templateFolders: [],
    inbox: [],
    settings: getDefaultSettings(),
  };
}
