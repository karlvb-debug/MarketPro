import { SQSEvent } from 'aws-lambda';
import { makeSqsHandler, processCampaignDispatch, PAGE_SIZE } from '../lambda/dispatch/core/engine';
import { RetryableDispatchError } from '../lambda/dispatch/core/errors';
import {
  ChannelAdapter,
  ClaimedRecipient,
  DispatchCampaign,
  DispatchContact,
  DispatchStore,
  SendResult,
} from '../lambda/dispatch/core/types';
import { Logger } from '../lambda/lib/logger';

// ---------- In-memory store ----------

function makeContact(n: number): DispatchContact {
  return {
    contactId: `c-${String(n).padStart(8, '0')}`,
    email: `user${n}@example.com`,
    phone: `+1555000${String(n).padStart(4, '0')}`,
    firstName: `First${n}`,
    lastName: `Last${n}`,
    company: null,
  };
}

interface MessageRow {
  messageId: string;
  contactId: string;
  status: 'queued' | 'sent' | 'failed';
  providerMessageId?: string | null;
  errorCode?: string;
}

class InMemoryStore implements DispatchStore {
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
  async fetchContactsPage(_segmentId: string, after: string | null, limit: number) {
    const sorted = [...this.contacts].sort((a, b) => a.contactId.localeCompare(b.contactId));
    const start = after ? sorted.findIndex((c) => c.contactId > after) : 0;
    if (start === -1) return [];
    return sorted.slice(start, start + limit);
  }
  async fetchSuppressedHashes(_ws: string, _kind: 'email' | 'phone', hashes: string[]) {
    return new Set(hashes.filter((h) => this.suppressedHashes.has(h)));
  }
  async claimRecipients(
    _campaign: DispatchCampaign,
    _channel: 'email' | 'sms' | 'voice',
    _fromIdentity: string,
    contacts: DispatchContact[],
  ): Promise<ClaimedRecipient[]> {
    const claimed: ClaimedRecipient[] = [];
    for (const contact of contacts) {
      if (this.messages.has(contact.contactId)) continue; // ON CONFLICT DO NOTHING
      const messageId = `m-${++this.seq}`;
      this.messages.set(contact.contactId, { messageId, contactId: contact.contactId, status: 'queued' });
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

type SendBehavior = (contact: DispatchContact) => SendResult | 'throw-retryable' | 'throw-fatal';

function makeAdapter(behavior?: SendBehavior): ChannelAdapter<{ body: string }, { body: string }> & {
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

const logger = new Logger({ test: true });
const payload = JSON.stringify({ campaignId: 'camp-1', workspaceId: 'ws-1' });

describe('processCampaignDispatch', () => {
  test('sends to every active contact and completes the campaign', async () => {
    const store = new InMemoryStore();
    store.contacts = [makeContact(1), makeContact(2), makeContact(3)];
    const adapter = makeAdapter();

    await processCampaignDispatch(payload, store, adapter, logger);

    expect(adapter.sendAttempts).toHaveLength(3);
    expect([...store.messages.values()].every((m) => m.status === 'sent')).toBe(true);
    expect(store.completedCount).toBe(3);
  });

  test('paginates large segments without loading everything at once', async () => {
    const store = new InMemoryStore();
    const total = PAGE_SIZE * 2 + 7; // forces 3 pages
    store.contacts = Array.from({ length: total }, (_, i) => makeContact(i));
    const pageSizes: number[] = [];
    const origFetch = store.fetchContactsPage.bind(store);
    store.fetchContactsPage = async (seg, after, limit) => {
      const page = await origFetch(seg, after, limit);
      pageSizes.push(page.length);
      return page;
    };

    await processCampaignDispatch(payload, store, makeAdapter(), logger);

    expect(pageSizes).toEqual([PAGE_SIZE, PAGE_SIZE, 7]);
    expect(store.completedCount).toBe(total);
  });

  test('redelivery sends nothing new (per-recipient idempotency)', async () => {
    const store = new InMemoryStore();
    store.contacts = [makeContact(1), makeContact(2)];
    const first = makeAdapter();
    await processCampaignDispatch(payload, store, first, logger);
    expect(first.sendAttempts).toHaveLength(2);

    // simulate SQS redelivery of the same campaign message
    store.campaign!.status = 'sending';
    const second = makeAdapter();
    await processCampaignDispatch(payload, store, second, logger);

    expect(second.sendAttempts).toHaveLength(0);
    expect(store.messages.size).toBe(2);
  });

  test('skips suppressed recipients', async () => {
    const store = new InMemoryStore();
    store.contacts = [makeContact(1), makeContact(2)];
    store.suppressedHashes.add('hash:user1@example.com');
    const adapter = makeAdapter();

    await processCampaignDispatch(payload, store, adapter, logger);

    expect(adapter.sendAttempts).toEqual([makeContact(2).contactId]);
  });

  test('records per-recipient failures and keeps going', async () => {
    const store = new InMemoryStore();
    store.contacts = [makeContact(1), makeContact(2)];
    const adapter = makeAdapter((c) =>
      c.contactId === makeContact(1).contactId
        ? { contactId: c.contactId, ok: false, errorCode: 'MessageRejected' }
        : { contactId: c.contactId, ok: true, providerMessageId: 'p2' },
    );

    await processCampaignDispatch(payload, store, adapter, logger);

    const rows = [...store.messages.values()];
    expect(rows.find((r) => r.contactId === makeContact(1).contactId)!.status).toBe('failed');
    expect(rows.find((r) => r.contactId === makeContact(2).contactId)!.status).toBe('sent');
    expect(store.completedCount).toBe(2);
  });

  test('cancels the campaign when the template is missing', async () => {
    const store = new InMemoryStore();
    store.contacts = [makeContact(1)];
    const adapter = makeAdapter();
    adapter.fetchTemplate = async () => undefined;

    await processCampaignDispatch(payload, store, adapter, logger);

    expect(store.cancelled).toBe('template_not_found');
    expect(store.messages.size).toBe(0);
  });

  test('cancels the campaign on adapter config errors', async () => {
    const store = new InMemoryStore();
    const adapter = makeAdapter();
    adapter.prepare = () => ({ configError: 'no_sms_origination_number' });

    await processCampaignDispatch(payload, store, adapter, logger);

    expect(store.cancelled).toBe('no_sms_origination_number');
  });

  test('skips completed and cancelled campaigns', async () => {
    for (const status of ['completed', 'cancelled', 'paused']) {
      const store = new InMemoryStore();
      store.campaign!.status = status;
      store.contacts = [makeContact(1)];
      const adapter = makeAdapter();

      await processCampaignDispatch(payload, store, adapter, logger);

      expect(adapter.sendAttempts).toHaveLength(0);
      expect(store.completedCount).toBeNull();
    }
  });

  test('poison payloads are dropped without touching the store', async () => {
    const store = new InMemoryStore();
    const fetchSpy = jest.spyOn(store, 'fetchCampaign');

    await processCampaignDispatch('not json', store, makeAdapter(), logger);
    await processCampaignDispatch(JSON.stringify({ campaignId: 'x' }), store, makeAdapter(), logger);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('propagates retryable errors (claims stay queued)', async () => {
    const store = new InMemoryStore();
    store.contacts = [makeContact(1)];
    const adapter = makeAdapter(() => 'throw-retryable');

    await expect(processCampaignDispatch(payload, store, adapter, logger)).rejects.toBeInstanceOf(
      RetryableDispatchError,
    );

    expect([...store.messages.values()][0]!.status).toBe('queued');
    expect(store.completedCount).toBeNull();
  });
});

describe('makeSqsHandler', () => {
  function sqsEvent(...bodies: string[]): SQSEvent {
    return {
      Records: bodies.map((body, i) => ({ body, messageId: `sqs-${i}` })),
    } as SQSEvent;
  }

  test('reports retryable failures as batch item failures', async () => {
    const store = new InMemoryStore();
    store.contacts = [makeContact(1)];
    const handler = makeSqsHandler(async () => store, makeAdapter(() => 'throw-retryable'));

    const response = await handler(sqsEvent(payload));

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'sqs-0' }]);
  });

  test('drops non-retryable failures instead of poisoning the queue', async () => {
    const store = new InMemoryStore();
    store.contacts = [makeContact(1)];
    const handler = makeSqsHandler(async () => store, makeAdapter(() => 'throw-fatal'));

    const response = await handler(sqsEvent(payload));

    expect(response.batchItemFailures).toEqual([]);
  });

  test('successful records return no failures', async () => {
    const store = new InMemoryStore();
    store.contacts = [makeContact(1)];
    const handler = makeSqsHandler(async () => store, makeAdapter());

    const response = await handler(sqsEvent(payload));

    expect(response.batchItemFailures).toEqual([]);
    expect(store.completedCount).toBe(1);
  });
});
