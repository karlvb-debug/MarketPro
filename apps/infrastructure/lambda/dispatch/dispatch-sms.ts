import { PinpointSMSVoiceV2Client, SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { smsTemplates } from '@repo/core/schema';
import { makeSqsHandler } from './sqs-handler';
import { createDispatchStore } from '@repo/core/dispatch/store';
import { isRetryableError, errorCodeOf, RetryableDispatchError } from '@repo/core/dispatch/errors';
import { mergeTags, phoneSuppressionHash } from '@repo/core/dispatch/personalize';
import { isWithinSendWindow } from '@repo/core/dispatch/quiet-hours';
import { ChannelAdapter, SendResult } from '@repo/core/dispatch/types';

const smsClient = new PinpointSMSVoiceV2Client({});

interface SmsTemplate {
  body: string | null;
}

interface SmsSetup {
  originationNumber: string;
  body: string;
}

const smsAdapter: ChannelAdapter<SmsTemplate, SmsSetup> = {
  channel: 'sms',
  suppressionHashKind: 'phone',

  async fetchTemplate(templateId, workspaceId) {
    const db = await getDb();
    const [row] = await db
      .select({ body: smsTemplates.body })
      .from(smsTemplates)
      .where(and(eq(smsTemplates.templateId, templateId), eq(smsTemplates.workspaceId, workspaceId)));
    return row;
  },

  prepare(_campaign, template, settings) {
    const originationNumber = settings?.smsPhoneNumber;
    if (!originationNumber) {
      return { configError: 'no_sms_origination_number' };
    }
    return {
      fromIdentity: originationNumber,
      setup: { originationNumber, body: template.body || '' },
    };
  },

  recipientOf(contact) {
    return contact.phone;
  },

  suppressionHashOf: phoneSuppressionHash,

  // TCPA: texts only 8am-9pm recipient local time
  skipReasonOf(contact, now) {
    return isWithinSendWindow(contact, now) ? null : 'quiet_hours';
  },

  async sendBatch(claimed, setup): Promise<SendResult[]> {
    const results: SendResult[] = [];
    for (const { contact } of claimed) {
      try {
        const response = await smsClient.send(
          new SendTextMessageCommand({
            DestinationPhoneNumber: contact.phone!,
            OriginationIdentity: setup.originationNumber,
            MessageBody: mergeTags(setup.body, contact),
            MessageType: 'PROMOTIONAL',
          }),
        );
        results.push({ contactId: contact.contactId, ok: true, providerMessageId: response.MessageId ?? null });
      } catch (err) {
        if (isRetryableError(err)) {
          throw new RetryableDispatchError('SMS send failed with retryable error', err);
        }
        results.push({ contactId: contact.contactId, ok: false, errorCode: errorCodeOf(err) });
      }
    }
    return results;
  },
};

export const handler = makeSqsHandler(createDispatchStore, smsAdapter);
