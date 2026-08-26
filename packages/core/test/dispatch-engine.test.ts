import { processCampaignDispatch, PAGE_SIZE } from '../src/dispatch/engine';
import { RetryableDispatchError } from '../src/dispatch/errors';
import { DispatchCampaign } from '../src/dispatch/types';
import type { DispatchPayload } from '../src/dispatch/engine';
import {
  InMemoryStore,
  makeAdapter,
  makeContact,
  logger,
  payload,
} from '../src/dispatch/testing';

describe('processCampaignDispatch', () => {
  test('sends to every active contact and completes the campaign', async () => {
    const store = new InMemoryStore();
    store.contacts = [makeContact(1), makeContact(2), makeContact(3)];
    const adapter = makeAdapter();

    await processCampaignDispatch(payload, store, adapter, logger);

    expect(adapter.sendAttempts).toHaveLength(3);
    expect([...store.messages.values()].every((m) => m.status === 'sent')).toBe(true);
    // Per-message cost stamped on every claim row for billing capture
    expect([...store.messages.values()].every((m) => m.cost === '0.010000')).toBe(true);
    expect(store.completedCount).toBe(3);
  });

  test('paginates large segments without loading everything at once', async () => {
    const store = new InMemoryStore();
    const total = PAGE_SIZE * 2 + 7; // forces 3 pages
    store.contacts = Array.from({ length: total }, (_, i) => makeContact(i));
    const pageSizes: number[] = [];
    const origFetch = store.fetchContactsPage.bind(store);
    store.fetchContactsPage = async (ws, seg, after, limit) => {
      const page = await origFetch(ws, seg, after, limit);
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

  test('compliance gate (skipReasonOf) skips without claiming', async () => {
    const store = new InMemoryStore();
    store.contacts = [makeContact(1), makeContact(2)];
    const adapter = makeAdapter();
    // Block contact 1 (e.g. quiet hours in their timezone)
    adapter.skipReasonOf = (contact) =>
      contact.contactId === makeContact(1).contactId ? 'quiet_hours' : null;

    await processCampaignDispatch(payload, store, adapter, logger);

    expect(adapter.sendAttempts).toEqual([makeContact(2).contactId]);
    // NOT claimed — a re-queue during allowed hours still reaches them
    expect(store.messages.has(makeContact(1).contactId)).toBe(false);
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

describe('processCampaignDispatch — continuation & quiet-hours self-heal', () => {
  type Requeued = { payload: DispatchPayload; delay: number };

  test('re-enqueues a cursor continuation when the time budget runs out, without completing', async () => {
    const store = new InMemoryStore();
    store.contacts = Array.from({ length: PAGE_SIZE * 2 }, (_, i) => makeContact(i));
    const adapter = makeAdapter();
    const requeued: Requeued[] = [];
    // Time budget already exhausted — stop after the first page (the check
    // runs after each page is sent).
    const timeRemainingMs = () => 0;

    await processCampaignDispatch(payload, store, adapter, logger, {
      requeue: async (p, delay) => { requeued.push({ payload: p, delay }); },
      timeRemainingMs,
    });

    expect(store.completedCount).toBeNull(); // did NOT complete
    expect(requeued).toHaveLength(1);
    expect(requeued[0]!.delay).toBe(0);
    expect(requeued[0]!.payload.afterContactId).toBe(makeContact(PAGE_SIZE - 1).contactId);
    expect(adapter.sendAttempts).toHaveLength(PAGE_SIZE); // only the first page sent
  });

  test('a continuation resumes from afterContactId and completes', async () => {
    const store = new InMemoryStore();
    store.contacts = Array.from({ length: 5 }, (_, i) => makeContact(i));
    // First three already claimed+sent in a prior invocation.
    for (let i = 0; i < 3; i++) {
      await store.claimRecipients({} as DispatchCampaign, 'email', 'f', [makeContact(i)], '0.01');
    }
    const adapter = makeAdapter();
    const resumePayload = JSON.stringify({
      campaignId: 'camp-1', workspaceId: 'ws-1', afterContactId: makeContact(2).contactId,
    });

    await processCampaignDispatch(resumePayload, store, adapter, logger, {
      requeue: async () => {},
      timeRemainingMs: () => 1_000_000,
    });

    // Only the unclaimed tail (3,4) is sent; campaign completes.
    expect(adapter.sendAttempts.sort()).toEqual([makeContact(3).contactId, makeContact(4).contactId]);
    expect(store.completedCount).toBe(5);
  });

  test('quiet-hours deferrals schedule a delayed full rescan instead of completing', async () => {
    const store = new InMemoryStore();
    store.contacts = [makeContact(1), makeContact(2)];
    const adapter = makeAdapter();
    adapter.skipReasonOf = (c) => (c.contactId === makeContact(1).contactId ? 'quiet_hours' : null);
    const requeued: Requeued[] = [];

    await processCampaignDispatch(payload, store, adapter, logger, {
      requeue: async (p, delay) => { requeued.push({ payload: p, delay }); },
      timeRemainingMs: () => 1_000_000,
    });

    expect(adapter.sendAttempts).toEqual([makeContact(2).contactId]); // in-window one sent
    expect(store.completedCount).toBeNull(); // deferred, not complete
    expect(requeued).toHaveLength(1);
    expect(requeued[0]!.delay).toBe(900);
    expect(requeued[0]!.payload.requeueCount).toBe(1);
    expect(requeued[0]!.payload.afterContactId ?? null).toBeNull(); // full rescan
  });

  test('rescan with everyone in-window completes and stops re-queueing', async () => {
    const store = new InMemoryStore();
    store.contacts = [makeContact(1), makeContact(2)];
    const adapter = makeAdapter(); // no skipReasonOf → nobody deferred
    const requeued: Requeued[] = [];

    await processCampaignDispatch(
      JSON.stringify({ campaignId: 'camp-1', workspaceId: 'ws-1', requeueCount: 1 }),
      store, adapter, logger,
      { requeue: async (p, delay) => { requeued.push({ payload: p, delay }); }, timeRemainingMs: () => 1_000_000 },
    );

    expect(requeued).toHaveLength(0);
    expect(store.completedCount).toBe(2);
  });

  test('deferrals stop re-queueing at the safety cap and complete', async () => {
    const store = new InMemoryStore();
    store.contacts = [makeContact(1)];
    const adapter = makeAdapter();
    adapter.skipReasonOf = () => 'quiet_hours';
    const requeued: Requeued[] = [];

    await processCampaignDispatch(
      JSON.stringify({ campaignId: 'camp-1', workspaceId: 'ws-1', requeueCount: 100 }),
      store, adapter, logger,
      { requeue: async (p, delay) => { requeued.push({ payload: p, delay }); }, timeRemainingMs: () => 1_000_000 },
    );

    expect(requeued).toHaveLength(0); // cap reached
    expect(store.completedCount).toBe(0); // completed (nobody sendable, but no longer pending)
  });

  test('without a requeue fn (default), behavior is unchanged — completes immediately', async () => {
    const store = new InMemoryStore();
    store.contacts = [makeContact(1)];
    const adapter = makeAdapter();
    adapter.skipReasonOf = () => 'quiet_hours';

    await processCampaignDispatch(payload, store, adapter, logger); // no options

    expect(store.completedCount).toBe(0); // legacy behavior: complete despite deferral
  });
});
