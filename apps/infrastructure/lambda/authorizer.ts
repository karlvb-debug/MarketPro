import { APIGatewayRequestAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { Pool } from 'pg';

// ============================================
// Workspace Authorizer — JWT verification + RBAC enforcement
// Validates that the authenticated user has a role in the requested workspace.
// Prevents IDOR / cross-tenant data breaches.
// ============================================

// 1. Initialize Cognito Verifier
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID || 'us-east-1_xxxxxxxxx',
  tokenUse: 'id',
  clientId: process.env.APP_CLIENT_ID || 'xxxxxxxxxxxxxx',
});

// 2. Reusable PG connection pool (warm-start friendly)
let pool: Pool | null = null;

async function getPool(): Promise<Pool> {
  if (pool) return pool;

  const secretArn = process.env.DATABASE_SECRET_ARN;
  const dbHost = process.env.DATABASE_HOST;
  const dbName = process.env.DATABASE_NAME || 'marketingsaas';

  let connectionString: string;

  if (secretArn) {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const smClient = new SecretsManagerClient({});
    const secret = await smClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const creds = JSON.parse(secret.SecretString || '{}');
    connectionString = `postgresql://${creds.username}:${encodeURIComponent(creds.password)}@${dbHost || creds.host}:${creds.port || 5432}/${dbName}`;
  } else {
    connectionString = process.env.DATABASE_URL || '';
  }

  pool = new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 5000,
    ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });

  return pool;
}

/**
 * Query users_workspaces to resolve the caller's role in the requested workspace.
 * Returns the role string or null if the user has no access.
 */
async function resolveWorkspaceRole(userId: string, workspaceId: string): Promise<string | null> {
  const client = await getPool();
  try {
    const result = await client.query(
      'SELECT role FROM users_workspaces WHERE user_id = $1 AND workspace_id = $2 LIMIT 1',
      [userId, workspaceId]
    );
    return result.rows.length > 0 ? result.rows[0].role : null;
  } catch (err) {
    console.warn(`Error resolving workspace role for user ${userId} and workspace ${workspaceId}:`, err);
    return null; // Graceful deny on invalid UUIDs etc
  }
}

export const handler = async (event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
  console.log('Authorizer invoked.');

  try {
    // 3. Extract and verify the JWT
    const authHeader = event.headers?.['Authorization'] || event.headers?.['authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) {
      throw new Error('Unauthorized');
    }

    const token = authHeader.split(' ')[1];
    const payload = await verifier.verify(token!);
    const userId = payload.sub;

    // 4. Check for Super Admin status via Cognito Groups
    const cognitoGroups: string[] = (payload as any)['cognito:groups'] || [];
    const isSuperAdmin = cognitoGroups.includes('SuperAdmins');

    // 5. Extract the workspace ID from the request header
    const workspaceId = event.headers?.['X-Workspace-Id'] || event.headers?.['x-workspace-id'];

    // Build the wildcard ARN for the cached policy
    const arnParts = event.methodArn.split(':');
    const apiGatewayArnParts = arnParts[5]!.split('/');
    const wildcardArn = arnParts.slice(0, 5).join(':') + ':' + apiGatewayArnParts[0] + '/' + apiGatewayArnParts[1] + '/*';

    // 6. If no workspace header (or the special global UUID), allow through (for /workspaces etc)
    const GLOBAL_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000';
    if (!workspaceId || workspaceId === GLOBAL_WORKSPACE_ID) {
      console.log(`User ${userId} authenticated (global context). SuperAdmin: ${isSuperAdmin}`);
      return generatePolicy(userId!, 'Allow', wildcardArn, {
        tenant_role: isSuperAdmin ? 'super_admin' : 'none',
        workspace_id: '',
        is_super_admin: isSuperAdmin ? 'true' : 'false',
      });
    }

    // 7. Super Admins bypass workspace membership — they can access any workspace
    if (isSuperAdmin) {
      console.log(`SUPER ADMIN: User ${userId} accessing workspace ${workspaceId} (impersonation mode)`);
      return generatePolicy(userId!, 'Allow', wildcardArn, {
        tenant_role: 'super_admin',
        workspace_id: workspaceId,
        is_super_admin: 'true',
      });
    }

    // 8. Standard RBAC: Verify the user has a role in the requested workspace
    const role = await resolveWorkspaceRole(userId!, workspaceId);

    if (!role) {
      console.warn(`RBAC DENIED: User ${userId} has no access to workspace ${workspaceId}`);
      return generatePolicy(userId!, 'Deny', wildcardArn, {
        tenant_role: 'denied',
        workspace_id: workspaceId,
        is_super_admin: 'false',
      });
    }

    console.log(`User ${userId} authorized as '${role}' in workspace ${workspaceId}.`);

    return generatePolicy(userId!, 'Allow', wildcardArn, {
      tenant_role: role,
      workspace_id: workspaceId,
      is_super_admin: 'false',
    });

  } catch (error) {
    console.error('Authorization failed:', error);
    throw new Error('Unauthorized');
  }
};

const generatePolicy = (
  principalId: string,
  effect: 'Allow' | 'Deny',
  resource: string,
  context?: Record<string, string>
): APIGatewayAuthorizerResult => {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    context,
  };
};
