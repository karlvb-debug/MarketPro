// ============================================
// Campaigns CRUD Lambda
// GET /campaigns — list
// POST /campaigns — create; due-now campaigns are launched immediately
// (claim → authorization hold → SQS), future ones are picked up by the
// scheduled-dispatch poller.
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { eq } from 'drizzle-orm';
import { getDb, getPool, respond, getWorkspaceId, getUserId, requireRole } from '../lib/db';
import { launchCampaign } from '../lib/campaign-launch';
import { Channel } from '../lib/billing';
import { campaigns } from '../../drizzle/schema';

const sqs = new SQSClient({});

const QUEUE_URLS: Record<Channel, string | undefined> = {
  email: process.env.EMAIL_DISPATCH_QUEUE_URL,
  sms: process.env.SMS_DISPATCH_QUEUE_URL,
  voice: process.env.VOICE_DISPATCH_QUEUE_URL,
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const userId = getUserId(event);
  if (!userId) return respond(401, { message: 'Unauthorized' });

  const workspaceId = getWorkspaceId(event);
  if (!workspaceId) return respond(400, { message: 'Missing X-Workspace-Id header' });

  const db = await getDb();
  const pathId = event.pathParameters?.id;

  try {
    // RBAC: All campaign routes require at least viewer
    const viewDenied = requireRole(event, 'viewer');
    if (viewDenied) return viewDenied;

    // GET /campaigns
    if (method === 'GET' && !pathId) {
      const rows = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.workspaceId, workspaceId))
        .orderBy(campaigns.createdAt);

      return respond(200, { data: rows });
    }

    // POST /campaigns — requires editor role
    if (method === 'POST') {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;

      const body = JSON.parse(event.body || '{}');
      const scheduledAt = body.scheduled_at ? new Date(body.scheduled_at) : null;
      const isFutureSend = scheduledAt !== null && scheduledAt > new Date();

      const [row] = await db.insert(campaigns).values({
        workspaceId,
        name: body.name || 'New Campaign',
        channel: body.channel || 'email',
        templateId: body.template_id || body.templateId,
        segmentId: body.segment_id || body.segmentId,
        // Future sends are 'scheduled' so the dispatch poller picks them up
        status: isFutureSend ? 'scheduled' : (body.status || 'draft'),
        scheduledAt,
      }).returning();

      const channel = row.channel as Channel;
      const queueUrl = QUEUE_URLS[channel];

      if (queueUrl && !isFutureSend) {
        const pool = await getPool();
        const result = await launchCampaign(
          pool,
          {
            campaignId: row.campaignId,
            workspaceId: row.workspaceId,
            segmentId: row.segmentId,
            channel,
            status: row.status,
          },
          async (payload) => {
            await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(payload) }));
          },
        );

        if (!result.ok && result.reason === 'insufficient_funds') {
          // Campaign reverted to draft — nothing queued, nothing held
          return respond(402, {
            message: 'Insufficient credits to send this campaign',
            campaignId: row.campaignId,
            required: result.required,
            available: result.available,
            recipients: result.recipients,
          });
        }
        if (result.ok) {
          row.status = 'sending';
          row.estimatedCost = result.estimatedCost;
        }
      }

      return respond(201, row);
    }

    return respond(405, { message: 'Method not allowed' });
  } catch (err) {
    console.error('Campaigns error:', err);
    return respond(500, { message: 'Internal server error' });
  }
};
