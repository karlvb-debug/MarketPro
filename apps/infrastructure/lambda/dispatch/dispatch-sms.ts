import { SQSEvent, SQSHandler } from 'aws-lambda';
import { PinpointSMSVoiceV2Client, SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { campaigns, smsTemplates, contacts, contactSegment, workspaceSettings, campaignMessages } from '../../drizzle/schema';

const smsClient = new PinpointSMSVoiceV2Client({});

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

      console.log(`Processing SMS campaign ${campaignId} for workspace ${workspaceId}`);

      // 1. Fetch Campaign
      const [campaign] = await db.select().from(campaigns).where(
        and(eq(campaigns.campaignId, campaignId), eq(campaigns.workspaceId, workspaceId))
      );

      if (!campaign || campaign.status === 'completed' || campaign.status === 'cancelled') {
        console.log(`Campaign ${campaignId} not found or already processed.`);
        continue;
      }

      // 2. Fetch Template
      const [template] = await db.select().from(smsTemplates).where(
        and(eq(smsTemplates.templateId, campaign.templateId), eq(smsTemplates.workspaceId, workspaceId))
      );

      if (!template) {
        console.error(`SMS Template not found for campaign ${campaignId}`);
        continue;
      }

      // 3. Fetch Workspace Settings
      const [settings] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId));
      
      const originationNumber = settings?.smsPhoneNumber;
      if (!originationNumber) {
        console.error(`No SMS origination number configured for workspace ${workspaceId}`);
        await db.update(campaigns).set({ status: 'cancelled' }).where(eq(campaigns.campaignId, campaignId));
        continue;
      }

      // 4. Fetch Segment Contacts
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

      let delivered = 0;
      let total = segmentContactsResult.length;

      // 5. Send SMS Messages via AWS End User Messaging v2
      for (const { contact } of segmentContactsResult) {
        if (!contact.phone) continue;

        try {
          let messageBody = template.body || '';
          messageBody = messageBody.replace(/{{first_name}}/g, contact.firstName || '');
          messageBody = messageBody.replace(/{{last_name}}/g, contact.lastName || '');
          messageBody = messageBody.replace(/{{company}}/g, contact.company || '');

          const response = await smsClient.send(new SendTextMessageCommand({
            DestinationPhoneNumber: contact.phone,
            OriginationIdentity: originationNumber,
            MessageBody: messageBody,
            MessageType: 'PROMOTIONAL', // or 'TRANSACTIONAL'
            // ConfigurationSetName can be added for delivery receipt tracking
          }));

          const providerMessageId = response.MessageId || 'unknown';

          // Log campaign message
          await db.insert(campaignMessages).values({
            campaignId,
            workspaceId,
            contactId: contact.contactId,
            channel: 'sms',
            status: 'sent',
            fromIdentity: originationNumber,
            sentAt: new Date(),
            providerMessageId,
          });

          delivered++;
        } catch (err: any) {
          console.error(`Failed to send SMS to ${contact.phone}:`, err.message);
          
          await db.insert(campaignMessages).values({
            campaignId,
            workspaceId,
            contactId: contact.contactId,
            channel: 'sms',
            status: 'failed',
            fromIdentity: originationNumber,
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

      console.log(`Campaign ${campaignId} completed. Sent ${delivered}/${total} SMS messages.`);
    } catch (err) {
      console.error('Error processing SMS SQS record:', err);
    }
  }
};
