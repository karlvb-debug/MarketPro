import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// ============================================
// Right to Be Forgotten — GDPR/CCPA deletion endpoint
// POST /contacts/{id}/forget (admin or owner only)
// Executes the Data Retention Matrix transactionally; see lib/gdpr.ts.
// ============================================

import { getPool, respond, getWorkspaceId, getUserId, requireRole } from './lib/db';
import { executeRightToBeForgotten } from '@repo/core/gdpr';
import { Logger } from '@repo/core/logger';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const logger = new Logger({ handler: 'right-to-be-forgotten' });

  const userId = getUserId(event);
  if (!userId) return respond(401, { message: 'Unauthorized' });

  const workspaceId = getWorkspaceId(event);
  if (!workspaceId) return respond(400, { message: 'Missing X-Workspace-Id header' });

  // Erasure is destructive and legally significant — admin and above only
  const denied = requireRole(event, 'admin');
  if (denied) return denied;

  const contactId = event.pathParameters?.id;
  if (!contactId) return respond(400, { message: 'Missing contact id' });

  try {
    const pool = await getPool();
    const result = await executeRightToBeForgotten(pool, workspaceId, contactId);

    if (!result) {
      return respond(404, { message: 'Contact not found' });
    }

    // Log the erasure event WITHOUT any PII — the act is auditable, the data is gone
    logger.info('Right-to-be-forgotten executed', {
      workspaceId,
      contactId,
      requestedBy: userId,
      ...result,
    });

    return respond(200, {
      message: 'Contact erased per data retention matrix',
      ...result,
    });
  } catch (err) {
    logger.error('Right-to-be-forgotten failed', err, { workspaceId, contactId });
    return respond(500, { message: 'Erasure failed — no partial deletion was applied. Retry the request.' });
  }
};
