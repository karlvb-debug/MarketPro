import { parseBillingEvent, settlementKindOf } from '../lambda/idempotent-billing-capture';

function snsWrap(message: object): string {
  return JSON.stringify({ Message: JSON.stringify(message) });
}

describe('parseBillingEvent', () => {
  test('parses an SES delivery event', () => {
    const body = snsWrap({
      eventType: 'Delivery',
      mail: { messageId: 'ses-123', destination: ['a@b.c'] },
      tags: { workspace_id: ['ws-1'] },
    });
    expect(parseBillingEvent(body)).toEqual({
      providerMessageId: 'ses-123',
      workspaceId: 'ws-1',
      eventType: 'delivery',
      recipientEmail: 'a@b.c',
    });
  });

  test('parses an SMS-style event with top-level messageId and status', () => {
    const body = snsWrap({
      messageId: 'sms-42',
      status: 'DELIVERED',
      tags: { workspace_id: ['ws-2'] },
    });
    expect(parseBillingEvent(body)).toMatchObject({
      providerMessageId: 'sms-42',
      workspaceId: 'ws-2',
      eventType: 'delivered',
      recipientEmail: null,
    });
  });

  test('returns null for malformed or incomplete payloads', () => {
    expect(parseBillingEvent('not json')).toBeNull();
    expect(parseBillingEvent(JSON.stringify({ Message: 'not json' }))).toBeNull();
    expect(parseBillingEvent(snsWrap({ eventType: 'Delivery' }))).toBeNull(); // no ids
    expect(
      parseBillingEvent(snsWrap({ mail: { messageId: 'x' }, tags: { workspace_id: ['ws'] } })),
    ).toBeNull(); // no event type
  });
});

describe('settlementKindOf', () => {
  test('delivery events capture', () => {
    expect(settlementKindOf('delivery')).toBe('capture');
    expect(settlementKindOf('delivered')).toBe('capture');
  });

  test('bounce/complaint/reject refund', () => {
    expect(settlementKindOf('bounce')).toBe('refund');
    expect(settlementKindOf('complaint')).toBe('refund');
    expect(settlementKindOf('reject')).toBe('refund');
  });

  test("'send' is NOT billable — capturing on send AND delivery would double-charge", () => {
    expect(settlementKindOf('send')).toBeNull();
    expect(settlementKindOf('open')).toBeNull();
    expect(settlementKindOf('click')).toBeNull();
  });
});
