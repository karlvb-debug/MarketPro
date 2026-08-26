// ============================================
// GET /batch — all workspace data in one call.
// Thin adapter; the logic lives in @repo/core/api/batch.
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { loadBatch } from '@repo/core/api/batch';
import { adapt } from '../lib/adapt';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> =>
  adapt(event, loadBatch);
