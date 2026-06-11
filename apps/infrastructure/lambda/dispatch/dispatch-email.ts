import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { emailTemplates } from '../../drizzle/schema';
import { makeSqsHandler } from './core/engine';
import { createDispatchStore } from './core/store';
import { isRetryableError, errorCodeOf, RetryableDispatchError } from './core/errors';
import { emailSuppressionHash, mergeTags } from './core/personalize';
import { ChannelAdapter, SendResult } from './core/types';

const ses = new SESClient({});

interface EmailTemplate {
  subjectLine: string | null;
  htmlContent: string | null;
}

interface EmailSetup {
  sourceStr: string;
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
    const sourceStr = fromName ? `${fromName} <${fromAddress}>` : fromAddress;
    return {
      fromIdentity: sourceStr,
      setup: {
        sourceStr,
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
    for (const { contact } of claimed) {
      try {
        const response = await ses.send(
          new SendEmailCommand({
            Source: setup.sourceStr,
            ReplyToAddresses: [setup.replyTo],
            Destination: { ToAddresses: [contact.email!] },
            Message: {
              Subject: { Data: setup.subject },
              Body: { Html: { Data: mergeTags(setup.html, contact) } },
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
