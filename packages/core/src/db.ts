// ============================================
// Shared DB connection
// Connects to Postgres via DATABASE_URL (Supabase/RDS/local alike).
// ============================================

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

let pool: Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;

/**
 * Resolve the Postgres connection string.
 *
 * One source of truth: DATABASE_URL. Secrets Manager is deliberately gone —
 * the platform reads secrets from its own env (Vercel/Supabase env vars), so
 * the connection string arrives already resolved. Never hardcode credentials.
 */
function buildConnectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  return url;
}

/** True for connection targets that don't terminate TLS (local dev). */
function isPlaintextTarget(connectionString: string): boolean {
  return connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
}

let warnedUnverifiedTls = false;

export interface SslConfig {
  ca?: string;
  rejectUnauthorized: boolean;
}

/**
 * TLS settings for the connection.
 *
 * Set `DATABASE_CA_CERT` to the PEM contents of the provider's CA (Supabase
 * publishes one per project) and the server certificate is actually verified.
 * Without it the connection is still encrypted but the certificate is not
 * checked, which does not stop an attacker who can intercept the connection
 * from presenting their own — so it warns once per process.
 *
 * This was inherited from the RDS deployment, where the database sat inside a
 * VPC and the exposure was bounded. Over the public internet it is not.
 */
export function sslConfig(connectionString: string): SslConfig | undefined {
  if (isPlaintextTarget(connectionString)) return undefined;

  const ca = process.env.DATABASE_CA_CERT;
  if (ca) return { ca, rejectUnauthorized: true };

  if (!warnedUnverifiedTls) {
    warnedUnverifiedTls = true;
    console.warn(
      '[db] DATABASE_CA_CERT is not set: the database connection is encrypted ' +
      'but the server certificate is NOT verified. Set it to the provider CA ' +
      'to enable verification.',
    );
  }
  return { rejectUnauthorized: false };
}

/** Test seam: reset the once-per-process warning. */
export function resetTlsWarning(): void {
  warnedUnverifiedTls = false;
}

/**
 * Shared pg connection pool, reused across warm invocations.
 * Used directly by callers that issue raw SQL; everything else goes via getDb().
 */
export async function getPool(): Promise<Pool> {
  if (pool) return pool;

  const connectionString = buildConnectionString();
  pool = new Pool({
    connectionString,
    max: 1,              // one concurrent connection per serverless invocation
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 10000,
    ssl: sslConfig(connectionString),
  });
  return pool;
}

/** Close the shared pool (tests only — serverless invocations keep it warm). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

/**
 * Returns a Drizzle ORM client, reusing the pool across warm invocations.
 */
export async function getDb() {
  if (db) return db;
  db = drizzle(await getPool(), { schema });
  return db;
}

// ============================================
// RBAC — role hierarchy (transport-independent)
// ============================================

/** Permission hierarchy — higher index = more permissions */
export const ROLE_HIERARCHY = ['viewer', 'editor', 'admin', 'owner', 'super_admin'] as const;
export type Role = typeof ROLE_HIERARCHY[number];

/**
 * True if `callerRole` meets or exceeds `minRole`.
 * Hierarchy: viewer < editor < admin < owner < super_admin
 */
export function roleMeetsMin(callerRole: string, minRole: Role): boolean {
  const callerLevel = ROLE_HIERARCHY.indexOf(callerRole as Role);
  const requiredLevel = ROLE_HIERARCHY.indexOf(minRole);
  return callerLevel >= requiredLevel;
}

/**
 * Map HTTP methods to action categories for audit logging.
 */
export function methodToAction(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET': return 'READ';
    case 'POST': return 'WRITE';
    case 'PUT': case 'PATCH': return 'WRITE';
    case 'DELETE': return 'DELETE';
    default: return 'READ';
  }
}
