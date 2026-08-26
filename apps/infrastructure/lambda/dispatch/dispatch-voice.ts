import {
  ConnectCampaignsClient,
  PutDialRequestBatchCommand,
} from '@aws-sdk/client-connectcampaigns';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { callScripts } from '@repo/core/schema';
import { makeSqsHandler } from './sqs-handler';
import { createDispatchStore } from '@repo/core/dispatch/store';
import { isRetryableError, errorCodeOf, RetryableDispatchError } from '@repo/core/dispatch/errors';
import { phoneSuppressionHash, toE164 } from '@repo/core/dispatch/personalize';
import { isWithinSendWindow } from '@repo/core/dispatch/quiet-hours';
import { ChannelAdapter, ClaimedRecipient, SendResult } from '@repo/core/dispatch/types';

const campaignsClient = new ConnectCampaignsClient({});

// PutDialRequestBatch hard limit
const DIAL_BATCH_SIZE = 25;
// Dial requests expire if Connect hasn't placed the call within this window
const DIAL_EXPIRATION_MS = 2 * 60 * 60 * 1000;

interface VoiceTemplate {
  ssmlContent: string | null;
  voicemailSsml: string | null;
  voiceId: string | null;
}

interface VoiceSetup {
  connectCampaignId: string;
  sourcePhoneNumber: string;
  template: VoiceTemplate;
  workspaceId: string;
}

const voiceAdapter: ChannelAdapter<VoiceTemplate, VoiceSetup> = {
  channel: 'voice',
  suppressionHashKind: 'phone',

  async fetchTemplate(templateId, workspaceId) {
    const db = await getDb();
    const [row] = await db
      .select({
        ssmlContent: callScripts.ssmlContent,
        voicemailSsml: callScripts.voicemailSsml,
        voiceId: callScripts.voiceId,
      })
      .from(callScripts)
      .where(and(eq(callScripts.scriptId, templateId), eq(callScripts.workspaceId, workspaceId)));
    return row;
  },

  prepare(campaign, template, settings) {
    const connectCampaignId = process.env.CONNECT_CAMPAIGN_ID;
    if (!connectCampaignId) {
      return { configError: 'connect_campaign_not_configured' };
    }
    const sourcePhoneNumber = settings?.voicePhoneNumber;
    if (!sourcePhoneNumber) {
      return { configError: 'no_voice_phone_number' };
    }
    return {
      fromIdentity: sourcePhoneNumber,
      setup: {
        connectCampaignId,
        sourcePhoneNumber,
        template,
        workspaceId: campaign.workspaceId,
      },
    };
  },

  recipientOf(contact) {
    return contact.phone;
  },

  suppressionHashOf: phoneSuppressionHash,

  // TCPA: calls only 8am-9pm recipient local time
  skipReasonOf(contact, now) {
    return isWithinSendWindow(contact, now) ? null : 'quiet_hours';
  },

  async sendBatch(claimed, setup, logger): Promise<SendResult[]> {
    const results: SendResult[] = [];

    for (let i = 0; i < claimed.length; i += DIAL_BATCH_SIZE) {
      const chunk = claimed.slice(i, i + DIAL_BATCH_SIZE);
      // clientToken = our campaign_messages PK, so retried API calls are
      // idempotent on the Connect side as well.
      const dialRequests = chunk.map(({ messageId, contact }: ClaimedRecipient) => ({
        clientToken: messageId,
        phoneNumber: toE164(contact.phone!),
        expirationTime: new Date(Date.now() + DIAL_EXPIRATION_MS),
        attributes: {
          FirstName: contact.firstName || '',
          LastName: contact.lastName || '',
          Company: contact.company || '',
          VoiceId: setup.template.voiceId || 'Joanna',
          SSMLContent: setup.template.ssmlContent || '<speak>Hello</speak>',
          VoicemailSSML:
            setup.template.voicemailSsml || setup.template.ssmlContent || '<speak>Hello</speak>',
          WorkspaceId: setup.workspaceId,
        },
      }));

      try {
        const response = await campaignsClient.send(
          new PutDialRequestBatchCommand({
            id: setup.connectCampaignId,
            dialRequests,
          }),
        );

        const failedByToken = new Map<string, string>();
        for (const fail of response.failedRequests ?? []) {
          if (fail.clientToken) {
            failedByToken.set(fail.clientToken, fail.failureCode || 'UnknownFailure');
          }
        }

        for (const { messageId, contact } of chunk) {
          const failureCode = failedByToken.get(messageId);
          if (failureCode) {
            results.push({ contactId: contact.contactId, ok: false, errorCode: failureCode });
          } else {
            results.push({ contactId: contact.contactId, ok: true, providerMessageId: messageId });
          }
        }
      } catch (err) {
        if (isRetryableError(err)) {
          throw new RetryableDispatchError('Connect dial batch failed with retryable error', err);
        }
        logger.error('Dial batch rejected — marking chunk failed', err);
        for (const { contact } of chunk) {
          results.push({ contactId: contact.contactId, ok: false, errorCode: errorCodeOf(err) });
        }
      }
    }

    return results;
  },
};

export const handler = makeSqsHandler(createDispatchStore, voiceAdapter);
