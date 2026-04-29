// ============================================
// Shared DB connection — cold-start optimized
// Reads credentials from Secrets Manager, connects to RDS
// ============================================

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../drizzle/schema';

let pool: Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;

/**
 * Returns a Drizzle ORM client connected to the RDS instance.
 * Reuses the connection pool across Lambda invocations (warm starts).
 * Reads credentials from the DATABASE_SECRET_ARN environment variable.
 */
export async function getDb() {
  if (db) return db;

  const secretArn = process.env.DATABASE_SECRET_ARN;
  const dbHost = process.env.DATABASE_HOST;
  const dbName = process.env.DATABASE_NAME || 'marketingsaas';

  let connectionString: string;

  if (secretArn) {
    // Production: read credentials from Secrets Manager
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const smClient = new SecretsManagerClient({});
    const secret = await smClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const creds = JSON.parse(secret.SecretString || '{}');
    connectionString = `postgresql://${creds.username}:${encodeURIComponent(creds.password)}@${dbHost || creds.host}:${creds.port || 5432}/${dbName}`;
  } else {
    // Fallback: use DATABASE_URL directly (for local dev)
    connectionString = process.env.DATABASE_URL || '';
  }

  pool = new Pool({
    connectionString,
    max: 1,              // Lambda = 1 concurrent connection per invocation
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 10000,
    ssl: { rejectUnauthorized: false },
  });

  db = drizzle(pool, { schema });
  return db;
}

/**
 * Standard API Gateway response helper
 */
export function respond(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Workspace-Id',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

/**
 * Extract workspace ID from the authorizer context or headers
 */
export function getWorkspaceId(event: any): string | null {
  // From custom header (passed through by API Gateway)
  return event.headers?.['X-Workspace-Id']
    || event.headers?.['x-workspace-id']
    || null;
}

/**
 * Extract user ID from the authorizer context
 */
export function getUserId(event: any): string | null {
  return event.requestContext?.authorizer?.principalId || null;
}

// ============================================
// RBAC Helpers
// ============================================

/** Permission hierarchy — higher index = more permissions */
const ROLE_HIERARCHY = ['viewer', 'editor', 'admin', 'owner', 'super_admin'] as const;
type Role = typeof ROLE_HIERARCHY[number];

/**
 * Extract the tenant role from the authorizer context.
 * Returns the role string injected by the authorizer Lambda.
 */
export function getTenantRole(event: any): string {
  return event.requestContext?.authorizer?.tenant_role || 'none';
}

/**
 * Check if the caller is a Super Admin (global platform access).
 */
export function isSuperAdmin(event: any): boolean {
  return getTenantRole(event) === 'super_admin';
}

/**
 * Check if the caller's role meets the minimum required role.
 * Returns true if authorized, false if denied.
 *
 * Hierarchy: viewer < editor < admin < owner < super_admin
 */
export function hasMinRole(event: any, minRole: Role): boolean {
  const callerRole = getTenantRole(event) as Role;
  const callerLevel = ROLE_HIERARCHY.indexOf(callerRole);
  const requiredLevel = ROLE_HIERARCHY.indexOf(minRole);
  return callerLevel >= requiredLevel;
}

/**
 * Guard that returns a 403 response if the caller lacks the minimum role.
 * Usage: const denied = requireRole(event, 'editor'); if (denied) return denied;
 */
export function requireRole(event: any, minRole: Role) {
  if (!hasMinRole(event, minRole)) {
    return respond(403, {
      message: `Forbidden: requires '${minRole}' role or higher`,
      yourRole: getTenantRole(event),
    });
  }
  return null; // Authorized
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
