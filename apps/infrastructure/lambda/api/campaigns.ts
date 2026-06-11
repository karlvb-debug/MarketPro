// ============================================
// Campaigns CRUD Lambda
// GET /campaigns — list
// POST /campaigns — create (+ authorization hold + dispatch)
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { and, eq, isNotNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { getDb, getPool, respond, getWorkspaceId, getUserId, requireRole } from '../lib/db';
import { authorizeCampaignFunds, getChannelPrice, multiplyPrice, Channel } from '../lib/billing';
import { campaigns, contacts, contactSegment } from '../../drizzle/schema';

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
      const [row] = await db.insert(campaigns).values({
        workspaceId,
        name: body.name || 'New Campaign',
        channel: body.channel || 'email',
        templateId: body.template_id || body.templateId,
        segmentId: body.segment_id || body.segmentId,
        status: body.status || 'draft',
        scheduledAt: body.scheduled_at ? new Date(body.scheduled_at) : null,
      }).returning();

      const channel = row.channel as Channel;
      const queueUrl = QUEUE_URLS[channel];
      const dueNow = !row.scheduledAt || row.scheduledAt <= new Date();

      if (queueUrl && dueNow) {
        // 1. Estimate: eligible recipients x per-message price.
        // (Scheduled-in-future campaigns are authorized when they fire — M5.)
        const recipientColumn = channel === 'email' ? contacts.email : contacts.phone;
        const [{ count }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(contactSegment)
          .innerJoin(contacts, eq(contactSegment.contactId, contacts.contactId))
          .where(
            and(
              eq(contactSegment.segmentId, row.segmentId),
              eq(contacts.status, 'active'),
              isNotNull(recipientColumn),
            ),
          );

        const pool = await getPool();
        const price = await getChannelPrice(pool, workspaceId, channel);
        const estimatedCost = await multiplyPrice(pool, price, count);

        // 2. Authorization hold: available -> hold, atomic balance check.
        if (parseFloat(estimatedCost) > 0) {
          const auth = await authorizeCampaignFunds(pool, workspaceId, row.campaignId, estimatedCost);
          if (!auth.ok) {
            // Campaign stays in draft — nothing was queued, nothing was held.
            return respond(402, {
              message: 'Insufficient credits to send this campaign',
              campaignId: row.campaignId,
              required: auth.required,
              available: auth.available,
              recipients: count,
            });
          }
        }

        // 3. Queue the dispatch and mark sending.
        await db
          .update(campaigns)
          .set({ estimatedCost })
          .where(eq(campaigns.campaignId, row.campaignId));

        await sqs.send(new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({
            campaignId: row.campaignId,
            workspaceId: row.workspaceId,
          }),
        }));

        await db.update(campaigns).set({ status: 'sending' }).where(eq(campaigns.campaignId, row.campaignId));
        row.status = 'sending';
        row.estimatedCost = estimatedCost;
      }

      return respond(201, row);
    }

    return respond(405, { message: 'Method not allowed' });
  } catch (err) {
    console.error('Campaigns error:', err);
    return respond(500, { message: 'Internal server error' });
  }
};
