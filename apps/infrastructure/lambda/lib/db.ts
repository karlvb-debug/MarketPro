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
