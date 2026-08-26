import { errorCodeOf, isRetryableError, RetryableDispatchError } from '../src/dispatch/errors';
import { mergeTags, toE164 } from '../src/dispatch/personalize';

describe('isRetryableError', () => {
  test('RetryableDispatchError is retryable', () => {
    expect(isRetryableError(new RetryableDispatchError('x'))).toBe(true);
  });

  test('AWS throttling shapes are retryable', () => {
    expect(isRetryableError({ name: 'ThrottlingException' })).toBe(true);
    expect(isRetryableError({ name: 'SomeError', $retryable: { throttling: true } })).toBe(true);
    expect(isRetryableError({ name: 'X', $metadata: { httpStatusCode: 503 } })).toBe(true);
    expect(isRetryableError({ name: 'X', $metadata: { httpStatusCode: 429 } })).toBe(true);
  });

  test('network and pg connection errors are retryable', () => {
    expect(isRetryableError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryableError({ code: '57P01' })).toBe(true); // admin_shutdown
    expect(isRetryableError({ code: '53300' })).toBe(true); // too_many_connections
    expect(isRetryableError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  test('data/validation errors are NOT retryable', () => {
    expect(isRetryableError({ name: 'MessageRejected', $metadata: { httpStatusCode: 400 } })).toBe(false);
    expect(isRetryableError({ name: 'ValidationException' })).toBe(false);
    expect(isRetryableError({ code: '23505' })).toBe(false); // unique_violation
    expect(isRetryableError(new Error('invalid email'))).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
    expect(isRetryableError('string error')).toBe(false);
  });
});

describe('errorCodeOf', () => {
  test('prefers name, fits the 100-char column', () => {
    expect(errorCodeOf({ name: 'MessageRejected' })).toBe('MessageRejected');
    expect(errorCodeOf({ message: 'x'.repeat(300) })).toHaveLength(100);
    expect(errorCodeOf(null)).toBe('null');
  });
});

describe('personalize', () => {
  const contact = {
    contactId: 'c1',
    email: 'a@b.c',
    phone: '555-123-4567',
    firstName: 'Ada',
    lastName: 'Lovelace',
    company: 'Analytical',
    timezone: null,
  };

  test('mergeTags supports both tag spellings', () => {
    expect(mergeTags('Hi {{firstName}} {{last_name}} of {{company}}', contact)).toBe(
      'Hi Ada Lovelace of Analytical',
    );
    expect(mergeTags('{{first_name}}', { ...contact, firstName: null })).toBe('');
  });

  test('toE164 normalizes US 10-digit numbers', () => {
    expect(toE164('555-123-4567')).toBe('+15551234567');
    expect(toE164('+447911123456')).toBe('+447911123456');
    expect(toE164('4479111234561')).toBe('+4479111234561');
  });
});
