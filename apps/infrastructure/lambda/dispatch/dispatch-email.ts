import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { emailTemplates } from '@repo/core/schema';
import { makeSqsHandler } from './sqs-handler';
import { createDispatchStore } from '@repo/core/dispatch/store';
import { isRetryableError, errorCodeOf, RetryableDispatchError } from '@repo/core/dispatch/errors';
import { emailSuppressionHash, mergeTags } from '@repo/core/dispatch/personalize';
import { ChannelAdapter, SendResult } from '@repo/core/dispatch/types';

// SESv2: the Simple content type supports custom headers, which the v1
// SendEmail API does not — required for RFC 8058 one-click unsubscribe.
const ses = new SESv2Client({});

// Public unsubscribe endpoint (UnsubscribeApi in email-stack); token appended per recipient
const UNSUBSCRIBE_BASE_URL = process.env.UNSUBSCRIBE_BASE_URL;

interface EmailTemplate {
  subjectLine: string | null;
  htmlContent: string | null;
}

interface EmailSetup {
  fromAddress: string;
  fromName: string;
  replyTo: string;
  subject: string;
  html: string;
}

const emailAdapter: ChannelAdapter<EmailTemplate, EmailSetup> = {
  channel: 'email',
  suppressionHashKind: 'email',

  async fetchTemplate(templateId, workspaceId) {
    const db = await getDb();
    const [row] = await db
      .select({
        subjectLine: emailTemplates.subjectLine,
        htmlContent: emailTemplates.htmlContent,
      })
      .from(emailTemplates)
      .where(and(eq(emailTemplates.templateId, templateId), eq(emailTemplates.workspaceId, workspaceId)));
    return row;
  },

  prepare(_campaign, template, settings) {
    const fromAddress = settings?.emailFromAddress || 'noreply@yourdomain.com';
    const fromName = settings?.emailFromName || 'Marketing SaaS';
    const replyTo = settings?.emailReplyTo || fromAddress;
    return {
      fromIdentity: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
      setup: {
        fromAddress,
        fromName,
        replyTo,
        subject: template.subjectLine || 'No Subject',
        html: template.htmlContent || '',
      },
    };
  },

  recipientOf(contact) {
    return contact.email;
  },

  suppressionHashOf: emailSuppressionHash,

  async sendBatch(claimed, setup): Promise<SendResult[]> {
    const results: SendResult[] = [];
    for (const { messageId, contact } of claimed) {
      try {
        // RFC 8058 One-Click Unsubscribe — token is this recipient's
        // campaign_messages UUID, resolved by the public /unsubscribe route.
        const headers = UNSUBSCRIBE_BASE_URL
          ? [
              { Name: 'List-Unsubscribe', Value: `<${UNSUBSCRIBE_BASE_URL}?token=${messageId}>` },
              { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
            ]
          : undefined;

        const response = await ses.send(
          new SendEmailCommand({
            FromEmailAddress: setup.fromName
              ? `${setup.fromName} <${setup.fromAddress}>`
              : setup.fromAddress,
            ReplyToAddresses: [setup.replyTo],
            Destination: { ToAddresses: [contact.email!] },
            Content: {
              Simple: {
                Subject: { Data: setup.subject },
                Body: { Html: { Data: mergeTags(setup.html, contact) } },
                Headers: headers,
              },
            },
          }),
        );
        results.push({ contactId: contact.contactId, ok: true, providerMessageId: response.MessageId ?? null });
      } catch (err) {
        if (isRetryableError(err)) {
          throw new RetryableDispatchError('SES send failed with retryable error', err);
        }
        results.push({ contactId: contact.contactId, ok: false, errorCode: errorCodeOf(err) });
      }
    }
    return results;
  },
};

export const handler = makeSqsHandler(createDispatchStore, emailAdapter);
