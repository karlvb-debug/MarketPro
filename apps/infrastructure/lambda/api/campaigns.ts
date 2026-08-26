// ============================================
// GET  /campaigns — list
// POST /campaigns — create; due-now campaigns are launched immediately
// Thin adapter; the logic lives in @repo/core/api/campaigns. This file owns
// the one AWS-specific piece: handing the dispatch payload to SQS.
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createCampaign, listCampaigns, type CampaignDeps } from '@repo/core/api/campaigns';
import { methodNotAllowed } from '@repo/core/api/result';
import type { Channel } from '@repo/core/billing';
import { adapt, bodyOf } from '../lib/adapt';

const sqs = new SQSClient({});

const QUEUE_URLS: Record<Channel, string | undefined> = {
  email: process.env.EMAIL_DISPATCH_QUEUE_URL,
  sms: process.env.SMS_DISPATCH_QUEUE_URL,
  voice: process.env.VOICE_DISPATCH_QUEUE_URL,
};

/**
 * A sender for the channel's SQS queue, or null when that channel has no
 * queue configured — which tells the core handler to create the campaign
 * without launching it, so no billing hold is placed for a send that could
 * never be queued.
 */
const deps: CampaignDeps = {
  senderFor: (channel) => {
    const queueUrl = QUEUE_URLS[channel];
    if (!queueUrl) return null;
    return async (payload) => {
      await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(payload),
      }));
    };
  },
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> =>
  adapt(event, async (ctx) => {
    const pathId = event.pathParameters?.id;

    if (event.httpMethod === 'GET' && !pathId) return listCampaigns(ctx);
    if (event.httpMethod === 'POST') return createCampaign(ctx, bodyOf(event), deps);
    return methodNotAllowed();
  });
