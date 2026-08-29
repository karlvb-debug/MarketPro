// TLS settings for the database connection. Encrypted-but-unverified is the
// fallback, not the intent: without a CA the certificate is not checked, which
// is a real exposure now that the database is reached over the public internet
// rather than from inside a VPC.

import { sslConfig, resetTlsWarning } from '../src/db';

const LOCAL = 'postgresql://u:p@localhost:5432/db';
const REMOTE = 'postgresql://u:p@db.example.supabase.co:5432/postgres';

describe('sslConfig', () => {
  const original = process.env.DATABASE_CA_CERT;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.DATABASE_CA_CERT;
    resetTlsWarning();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    if (original === undefined) delete process.env.DATABASE_CA_CERT;
    else process.env.DATABASE_CA_CERT = original;
  });

  test('local connections skip TLS entirely', () => {
    expect(sslConfig(LOCAL)).toBeUndefined();
    expect(sslConfig('postgresql://u:p@127.0.0.1:5432/db')).toBeUndefined();
  });

  test('a provided CA turns on real certificate verification', () => {
    process.env.DATABASE_CA_CERT = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    const cfg = sslConfig(REMOTE);
    expect(cfg).toEqual({ ca: process.env.DATABASE_CA_CERT, rejectUnauthorized: true });
  });

  test('without a CA the connection is unverified and says so', () => {
    const cfg = sslConfig(REMOTE);
    expect(cfg).toEqual({ rejectUnauthorized: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('NOT verified');
  });

  test('the warning is once per process, not once per connection', () => {
    sslConfig(REMOTE);
    sslConfig(REMOTE);
    sslConfig(REMOTE);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('a local target never warns, even with no CA', () => {
    sslConfig(LOCAL);
    expect(warn).not.toHaveBeenCalled();
  });
});
