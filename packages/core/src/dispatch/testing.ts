// ============================================
// In-memory test doubles for the dispatch engine.
//
// Shared so that both the engine's own tests and any transport adapter's
// tests (SQS today, cron/pg-boss in M4) exercise the engine against the same
// fakes. Not used in production code paths.
// ============================================

import {
  ChannelAdapter,
  ClaimedRecipient,
  DispatchCampaign,
  DispatchContact,
  DispatchStore,
  SendResult,
} from './types';
import { RetryableDispatchError } from './errors';
import { Logger } from '../logger';

// ---------- In-memory store ----------

export function makeContact(n: number): DispatchContact {
  return {
    contactId: `c-${String(n).padStart(8, '0')}`,
    email: `user${n}@example.com`,
    phone: `+1555000${String(n).padStart(4, '0')}`,
    firstName: `First${n}`,
    lastName: `Last${n}`,
    company: null,
    timezone: null,
  };
}

export interface MessageRow {
  messageId: string;
  contactId: string;
  status: 'queued' | 'sent' | 'failed';
  providerMessageId?: string | null;
  errorCode?: string;
  cost?: string;
}

export class InMemoryStore implements DispatchStore {
  campaign: DispatchCampaign | undefined = {
    campaignId: 'camp-1',
    workspaceId: 'ws-1',
    templateId: 'tpl-1',
    segmentId: 'seg-1',
    status: 'sending',
  };
  contacts: DispatchContact[] = [];
  suppressedHashes = new Set<string>();
  messages = new Map<string, MessageRow>(); // key: contactId
  cancelled: string | null = null;
  completedCount: number | null = null;
  private seq = 0;

  async fetchCampaign() {
    return this.campaign;
  }
  async fetchSettings() {
    return {
      emailFromAddress: 'from@x.com',
      emailFromName: 'X',
      emailReplyTo: null,
      smsPhoneNumber: '+15550001111',
      voicePhoneNumber: '+15550002222',
    };
  }
  async cancelCampaign(_campaignId: string, reason: string) {
    this.cancelled = reason;
  }
  async fetchContactsPage(_workspaceId: string, _segmentId: string, after: string | null, limit: number) {
    const sorted = [...this.contacts].sort((a, b) => a.contactId.localeCompare(b.contactId));
    const start = after ? sorted.findIndex((c) => c.contactId > after) : 0;
    if (start === -1) return [];
    return sorted.slice(start, start + limit);
  }
  async fetchSuppressedHashes(_ws: string, _kind: 'email' | 'phone', hashes: string[]) {
    return new Set(hashes.filter((h) => this.suppressedHashes.has(h)));
  }
  async fetchChannelPrice(): Promise<string> {
    return '0.010000';
  }
  async claimRecipients(
    _campaign: DispatchCampaign,
    _channel: 'email' | 'sms' | 'voice',
    _fromIdentity: string,
    contacts: DispatchContact[],
    costPerMessage: string,
  ): Promise<ClaimedRecipient[]> {
    const claimed: ClaimedRecipient[] = [];
    for (const contact of contacts) {
      if (this.messages.has(contact.contactId)) continue; // ON CONFLICT DO NOTHING
      const messageId = `m-${++this.seq}`;
      this.messages.set(contact.contactId, {
        messageId,
        contactId: contact.contactId,
        status: 'queued',
        cost: costPerMessage,
      });
      claimed.push({ messageId, contact });
    }
    return claimed;
  }
  async markSent(messageId: string, providerMessageId: string | null) {
    const row = [...this.messages.values()].find((m) => m.messageId === messageId)!;
    row.status = 'sent';
    row.providerMessageId = providerMessageId;
  }
  async markFailed(messageId: string, errorCode: string) {
    const row = [...this.messages.values()].find((m) => m.messageId === messageId)!;
    row.status = 'failed';
    row.errorCode = errorCode;
  }
  async completeCampaign() {
    this.completedCount = this.messages.size;
    return this.messages.size;
  }
}

// ---------- Fake adapter ----------

export type SendBehavior = (contact: DispatchContact) => SendResult | 'throw-retryable' | 'throw-fatal';

export function makeAdapter(behavior?: SendBehavior): ChannelAdapter<{ body: string }, { body: string }> & {
  sendAttempts: string[];
} {
  const sendAttempts: string[] = [];
  return {
    sendAttempts,
    channel: 'email',
    suppressionHashKind: 'email',
    async fetchTemplate() {
      return { body: 'hello {{firstName}}' };
    },
    prepare(_campaign, template) {
      return { setup: template, fromIdentity: 'from@x.com' };
    },
    recipientOf(contact) {
      return contact.email;
    },
    suppressionHashOf(contact) {
      return `hash:${contact.email}`;
    },
    async sendBatch(claimed) {
      const results: SendResult[] = [];
      for (const { contact } of claimed) {
        sendAttempts.push(contact.contactId);
        const custom = behavior?.(contact);
        if (custom === 'throw-retryable') throw new RetryableDispatchError('throttled');
        if (custom === 'throw-fatal') throw new Error('boom');
        results.push(
          custom ?? { contactId: contact.contactId, ok: true, providerMessageId: `prov-${contact.contactId}` },
        );
      }
      return results;
    },
  };
}

export const logger = new Logger({ test: true });
export const payload = JSON.stringify({ campaignId: 'camp-1', workspaceId: 'ws-1' });
