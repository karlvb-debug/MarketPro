// ============================================
// GET  /campaigns — list
// POST /campaigns — create; due-now campaigns are launched immediately
// (claim → authorization hold → enqueue), future ones are left 'scheduled'
// for the dispatch poller to pick up.
// ============================================

import { eq } from 'drizzle-orm';
import { getDb, getPool } from '../db';
import { launchCampaign } from '../campaign-launch';
import type { Channel } from '../billing';
import { campaigns, campaignStatusEnum, channelEnum } from '../schema';
import type { RequestContext } from './context';
import {
  type ApiResult,
  badRequest,
  created,
  ok,
  paymentRequired,
  requireRole,
  requireWorkspace,
} from './result';
import { type JsonBody, str } from './input';

// Taken from the schema enums so the accepted values cannot drift from the
// database's own constraint.
const CHANNELS = channelEnum.enumValues;
const CAMPAIGN_STATUSES = campaignStatusEnum.enumValues;

type CampaignStatus = typeof CAMPAIGN_STATUSES[number];

function isChannel(v: string): v is Channel {
  return (CHANNELS as readonly string[]).includes(v);
}

function isCampaignStatus(v: string): v is CampaignStatus {
  return (CAMPAIGN_STATUSES as readonly string[]).includes(v);
}

/**
 * How this deployment hands a dispatch payload to its queue. SQS under
 * Lambda, pg-boss under Vercel Cron (M4). Undefined means the deployment
 * cannot dispatch the channel, in which case the campaign is created but not
 * launched — exactly what a missing queue URL used to do.
 */
export interface CampaignDeps {
  enqueue?: (channel: Channel, payload: unknown) => Promise<void>;
}

export async function listCampaigns(ctx: RequestContext): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'viewer');
  if (denied) return denied;

  const db = await getDb();
  const rows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.workspaceId, ctx.workspaceId))
    .orderBy(campaigns.createdAt);

  return ok({ data: rows });
}

export async function createCampaign(
  ctx: RequestContext,
  body: JsonBody,
  deps: CampaignDeps = {},
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'editor');
  if (denied) return denied;

  const db = await getDb();

  const scheduledRaw = str(body, 'scheduled_at', 'scheduledAt');
  const scheduledAt = scheduledRaw ? new Date(scheduledRaw) : null;
  const isFutureSend =
    scheduledAt !== null && !Number.isNaN(scheduledAt.getTime()) && scheduledAt > new Date();

  // templateId and segmentId are NOT NULL; validate rather than letting the
  // insert fail as an opaque 500 (which is what the Lambda handler did).
  const templateId = str(body, 'template_id', 'templateId');
  if (!templateId) return badRequest('template_id is required');
  const segmentId = str(body, 'segment_id', 'segmentId');
  if (!segmentId) return badRequest('segment_id is required');

  const channelInput = str(body, 'channel') || 'email';
  if (!isChannel(channelInput)) {
    return badRequest(`channel must be one of ${CHANNELS.join(', ')}`);
  }

  const statusInput = isFutureSend ? 'scheduled' : (str(body, 'status') || 'draft');
  if (!isCampaignStatus(statusInput)) {
    return badRequest(`status must be one of ${CAMPAIGN_STATUSES.join(', ')}`);
  }

  const [row] = await db.insert(campaigns).values({
    workspaceId: ctx.workspaceId,
    name: str(body, 'name') || 'New Campaign',
    channel: channelInput,
    templateId,
    segmentId,
    // Future sends are 'scheduled' so the dispatch poller picks them up
    status: statusInput,
    scheduledAt: scheduledAt && !Number.isNaN(scheduledAt.getTime()) ? scheduledAt : null,
  }).returning();

  const campaign = row!;
  const channel = campaign.channel as Channel;

  if (deps.enqueue && !isFutureSend) {
    const pool = await getPool();
    const result = await launchCampaign(
      pool,
      {
        campaignId: campaign.campaignId,
        workspaceId: campaign.workspaceId,
        segmentId: campaign.segmentId,
        channel,
        status: campaign.status,
      },
      async (payload) => {
        await deps.enqueue!(channel, payload);
      },
    );

    if (!result.ok && result.reason === 'insufficient_funds') {
      // Campaign reverted to draft — nothing queued, nothing held
      return paymentRequired('Insufficient credits to send this campaign', {
        campaignId: campaign.campaignId,
        required: result.required,
        available: result.available,
        recipients: result.recipients,
      });
    }
    if (result.ok) {
      campaign.status = 'sending';
      campaign.estimatedCost = result.estimatedCost;
    }
  }

  return created(campaign);
}
