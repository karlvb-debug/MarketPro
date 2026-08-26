import { isWithinSendWindow, localHourIn } from '@repo/core/dispatch/quiet-hours';
import { detectKeyword, parseInboundSms } from '../lambda/inbound-sms';
import {
  normalizeEmail,
  normalizePhone,
  normalizeContactRow,
  sanitizeCustomFields,
} from '@repo/core/contact-validate';

describe('quiet hours (TCPA 8am-9pm local)', () => {
  // 2026-06-11 (EDT = UTC-4, PDT = UTC-7)
  const atUtc = (hour: number) => new Date(Date.UTC(2026, 5, 11, hour, 30, 0));

  test('localHourIn resolves IANA zones and rejects junk', () => {
    expect(localHourIn('America/New_York', atUtc(16))).toBe(12);
    expect(localHourIn('America/Los_Angeles', atUtc(16))).toBe(9);
    expect(localHourIn('Not/AZone', atUtc(16))).toBeNull();
  });

  test('explicit contact timezone is enforced', () => {
    // 16:30 UTC = 12:30pm ET (allowed), 9:30am PT (allowed), 5:30am HST (blocked)
    expect(isWithinSendWindow({ timezone: 'America/New_York' }, atUtc(16))).toBe(true);
    expect(isWithinSendWindow({ timezone: 'Pacific/Honolulu' }, atUtc(16))).toBe(false);
    // 01:30 UTC = 9:30pm ET previous evening — blocked
    expect(isWithinSendWindow({ timezone: 'America/New_York' }, atUtc(1))).toBe(false);
  });

  test('unknown timezone uses the conservative continental window', () => {
    // 16:30 UTC: ET 12:30pm, PT 9:30am — every continental zone inside 8-21
    expect(isWithinSendWindow({ timezone: null }, atUtc(16))).toBe(true);
    // 13:30 UTC: PT is 6:30am — too early somewhere, so blocked
    expect(isWithinSendWindow({ timezone: null }, atUtc(13))).toBe(false);
    // 02:30 UTC: ET 10:30pm — too late somewhere, so blocked
    expect(isWithinSendWindow({ timezone: null }, atUtc(2))).toBe(false);
  });

  test('invalid timezone string falls back to the conservative window', () => {
    expect(isWithinSendWindow({ timezone: 'Mars/OlympusMons' }, atUtc(16))).toBe(true);
    expect(isWithinSendWindow({ timezone: 'Mars/OlympusMons' }, atUtc(2))).toBe(false);
  });
});

describe('SMS keyword detection', () => {
  test('STOP family', () => {
    for (const word of ['STOP', 'stop', ' Stop ', 'UNSUBSCRIBE', 'cancel', 'END', 'quit', 'STOPALL', 'stop.']) {
      expect(detectKeyword(word)).toBe('STOP');
    }
  });

  test('START and HELP families', () => {
    expect(detectKeyword('START')).toBe('START');
    expect(detectKeyword('unstop')).toBe('START');
    expect(detectKeyword('HELP')).toBe('HELP');
    expect(detectKeyword('info')).toBe('HELP');
  });

  test('ordinary messages are not keywords', () => {
    expect(detectKeyword('stop by tomorrow!')).toBeNull();
    expect(detectKeyword('hello')).toBeNull();
    expect(detectKeyword('')).toBeNull();
    expect(detectKeyword(null)).toBeNull();
  });
});

describe('parseInboundSms', () => {
  test('parses End User Messaging inbound payloads', () => {
    const msg = JSON.stringify({
      originationNumber: '+15551112222',
      destinationNumber: '+15553334444',
      messageBody: 'STOP',
    });
    expect(parseInboundSms(msg)).toEqual({
      originationNumber: '+15551112222',
      destinationNumber: '+15553334444',
      messageBody: 'STOP',
    });
  });

  test('rejects malformed payloads', () => {
    expect(parseInboundSms('nope')).toBeNull();
    expect(parseInboundSms(JSON.stringify({ messageBody: 'hi' }))).toBeNull();
  });
});

describe('contact validation', () => {
  test('normalizeEmail lowercases, trims, and rejects junk', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('two@@example.com')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull(); // no TLD
    expect(normalizeEmail(42)).toBeNull();
  });

  test('normalizePhone canonicalizes to E.164', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('+44 7911 123456')).toBe('+447911123456');
    expect(normalizePhone('12345')).toBeNull(); // too short
  });

  test('sanitizeCustomFields drops nested values and caps lengths', () => {
    const result = sanitizeCustomFields({
      plan: 'pro',
      score: 42,
      active: true,
      nested: { evil: true },
      list: [1, 2],
      long: 'x'.repeat(5000),
    });
    expect(result.plan).toBe('pro');
    expect(result.score).toBe(42);
    expect(result.active).toBe(true);
    expect(result.nested).toBeUndefined();
    expect(result.list).toBeUndefined();
    expect((result.long as string).length).toBe(1000);
  });

  test('normalizeContactRow rejects unreachable rows', () => {
    expect(normalizeContactRow({ first_name: 'Ada' })).toBeNull();
    expect(normalizeContactRow({ email: 'bad', phone: '12' })).toBeNull();
    expect(normalizeContactRow({ email: 'A@B.co', first_name: ' Ada ' })).toMatchObject({
      email: 'a@b.co',
      firstName: 'Ada',
      phone: null,
    });
  });
});
