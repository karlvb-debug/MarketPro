// ============================================
// Scheduled campaign dispatcher
// EventBridge rule (every 5 minutes) → launches campaigns whose
// scheduled_at has come due: claim → authorize hold → queue dispatch.
// Insufficient funds parks the campaign as 'paused' for the operator.
// Race-safe across overlapping ticks via the conditional claim.
// ============================================

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getPool } from './lib/db';
import { findDueCampaigns, launchCampaign, pauseCampaign } from './lib/campaign-launch';
import { Channel } from './lib/billing';
import { Logger } from './lib/logger';

const sqs = new SQSClient({});

const QUEUE_URLS: Record<Channel, string | undefined> = {
  email: process.env.EMAIL_DISPATCH_QUEUE_URL,
  sms: process.env.SMS_DISPATCH_QUEUE_URL,
  voice: process.env.VOICE_DISPATCH_QUEUE_URL,
};

export const handler = async (): Promise<{ launched: number; paused: number; skipped: number }> => {
  const logger = new Logger({ handler: 'scheduled-dispatch' });
  const pool = await getPool();

  const due = await findDueCampaigns(pool);
  let launched = 0;
  let paused = 0;
  let skipped = 0;

  for (const campaign of due) {
    const campaignLogger = logger.with({ campaignId: campaign.campaignId, channel: campaign.channel });
    const queueUrl = QUEUE_URLS[campaign.channel];
    if (!queueUrl) {
      campaignLogger.error('No dispatch queue configured for channel — pausing campaign');
      await pauseCampaign(pool, campaign.campaignId);
      paused++;
      continue;
    }

    try {
      const result = await launchCampaign(pool, campaign, async (payload) => {
        await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(payload) }));
      });

      if (result.ok) {
        campaignLogger.info('Scheduled campaign launched', {
          estimatedCost: result.estimatedCost,
          recipients: result.recipients,
        });
        launched++;
      } else if (result.reason === 'insufficient_funds') {
        campaignLogger.warn('Insufficient funds — pausing campaign', {
          required: result.required,
          available: result.available,
        });
        await pauseCampaign(pool, campaign.campaignId);
        paused++;
      } else {
        skipped++; // already claimed by a concurrent tick
      }
    } catch (err) {
      // Claim was reverted inside launchCampaign — next tick retries
      campaignLogger.error('Failed to launch scheduled campaign — will retry next tick', err);
    }
  }

  logger.info('Scheduled dispatch tick complete', { due: due.length, launched, paused, skipped });
  return { launched, paused, skipped };
};
