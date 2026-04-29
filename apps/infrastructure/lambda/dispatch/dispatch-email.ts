import { SQSEvent, SQSHandler } from 'aws-lambda';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { campaigns, emailTemplates, contacts, contactSegment, workspaceSettings, campaignMessages } from '../../drizzle/schema';

const ses = new SESClient({});

export const handler: SQSHandler = async (event: SQSEvent) => {
  const db = await getDb();

  for (const record of event.Records) {
    try {
      const payload = JSON.parse(record.body);
      const { campaignId, workspaceId } = payload;

      if (!campaignId || !workspaceId) {
        console.error('Invalid payload:', payload);
        continue;
      }

      console.log(`Processing campaign ${campaignId} for workspace ${workspaceId}`);

      // 1. Fetch Campaign
      const [campaign] = await db.select().from(campaigns).where(
        and(eq(campaigns.campaignId, campaignId), eq(campaigns.workspaceId, workspaceId))
      );

      if (!campaign || campaign.status === 'completed' || campaign.status === 'cancelled') {
        console.log(`Campaign ${campaignId} not found or already processed/cancelled.`);
        continue;
      }

      // 2. Fetch Template
      const [template] = await db.select().from(emailTemplates).where(
        and(eq(emailTemplates.templateId, campaign.templateId), eq(emailTemplates.workspaceId, workspaceId))
      );

      if (!template) {
        console.error(`Template not found for campaign ${campaignId}`);
        continue;
      }

      // 3. Fetch Workspace Settings for sending identity
      const [settings] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId));
      
      const fromAddress = settings?.emailFromAddress || 'noreply@yourdomain.com';
      const fromName = settings?.emailFromName || 'Marketing SaaS';
      const replyTo = settings?.emailReplyTo || fromAddress;

      const sourceStr = fromName ? `${fromName} <${fromAddress}>` : fromAddress;

      // 4. Fetch Segment Contacts
      // We join contactSegment with contacts
      const segmentContactsResult = await db.select({
        contact: contacts,
      })
      .from(contactSegment)
      .innerJoin(contacts, eq(contactSegment.contactId, contacts.contactId))
      .where(
        and(
          eq(contactSegment.segmentId, campaign.segmentId),
          eq(contacts.status, 'active')
        )
      );

      // In a real app, you would also filter against the suppressionList here using SHA-256 of emails.

      let delivered = 0;
      let total = segmentContactsResult.length;

      // 5. Send Emails
      for (const { contact } of segmentContactsResult) {
        if (!contact.email) continue;

        try {
          // Replace merge tags (basic implementation)
          let htmlBody = template.htmlContent || '';
          htmlBody = htmlBody.replace(/{{firstName}}/g, contact.firstName || '');
          htmlBody = htmlBody.replace(/{{lastName}}/g, contact.lastName || '');

          const response = await ses.send(new SendEmailCommand({
            Source: sourceStr,
            ReplyToAddresses: [replyTo],
            Destination: { ToAddresses: [contact.email] },
            Message: {
              Subject: { Data: template.subjectLine || 'No Subject' },
              Body: { Html: { Data: htmlBody } },
            },
          }));

          // Log campaign message
          await db.insert(campaignMessages).values({
            campaignId,
            workspaceId,
            contactId: contact.contactId,
            channel: 'email',
            status: 'sent',
            fromIdentity: sourceStr,
            sentAt: new Date(),
            providerMessageId: response.MessageId,
          });

          delivered++;
        } catch (err: any) {
          console.error(`Failed to send to ${contact.email}:`, err.message);
          
          await db.insert(campaignMessages).values({
            campaignId,
            workspaceId,
            contactId: contact.contactId,
            channel: 'email',
            status: 'failed',
            fromIdentity: sourceStr,
            errorCode: err.message?.substring(0, 100),
          });
        }
      }

      // 6. Complete Campaign
      await db.update(campaigns).set({
        status: 'completed',
        completedAt: new Date(),
        totalRecipients: total,
      }).where(eq(campaigns.campaignId, campaignId));

      console.log(`Campaign ${campaignId} completed. Sent ${delivered}/${total} emails.`);
    } catch (err) {
      console.error('Error processing SQS record:', err);
      // Not throwing so we don't retry poison pills, though in production DLQ is better.
    }
  }
};
