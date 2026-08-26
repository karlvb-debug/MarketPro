// SQS-transport behaviour only — the engine's own semantics are covered by
// packages/core/test/dispatch-engine.test.ts against the same fakes.
import { SQSEvent } from 'aws-lambda';
import { makeSqsHandler } from '../lambda/dispatch/sqs-handler';
import { InMemoryStore, makeAdapter, makeContact, payload } from '@repo/core/dispatch/testing';

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
