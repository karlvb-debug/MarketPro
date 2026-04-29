import { SQSEvent, SQSHandler } from 'aws-lambda';
import { ConnectClient, StartOutboundVoiceContactCommand } from '@aws-sdk/client-connect';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { campaigns, callScripts, contacts, contactSegment, workspaceSettings, campaignMessages } from '../../drizzle/schema';

const connectClient = new ConnectClient({});
const INSTANCE_ID = process.env.CONNECT_INSTANCE_ID;
const CONTACT_FLOW_ID = process.env.CONTACT_FLOW_ID;

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

      console.log(`Processing Voice campaign ${campaignId} for workspace ${workspaceId}`);

      // 1. Fetch Campaign
      const [campaign] = await db.select().from(campaigns).where(
        and(eq(campaigns.campaignId, campaignId), eq(campaigns.workspaceId, workspaceId))
      );

      if (!campaign || campaign.status === 'completed' || campaign.status === 'cancelled') {
        console.log(`Campaign ${campaignId} not found or already processed.`);
        continue;
      }

      // 2. Fetch Call Script (Template)
      const [template] = await db.select().from(callScripts).where(
        and(eq(callScripts.scriptId, campaign.templateId), eq(callScripts.workspaceId, workspaceId))
      );

      if (!template) {
        console.error(`Call Script not found for campaign ${campaignId}`);
        continue;
      }

      // 3. Fetch Workspace Settings
      const [settings] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId));
      
      const sourcePhoneNumber = settings?.voicePhoneNumber;
      if (!sourcePhoneNumber) {
        console.error(`No Voice phone number configured for workspace ${workspaceId}`);
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

      // 5. Initiate Calls
      for (const { contact } of segmentContactsResult) {
        if (!contact.phone) continue;

        try {
          // You could pass attributes to Connect here to use in the contact flow
          // like {{firstName}} -> Attributes.FirstName
          const contactAttributes = {
            FirstName: contact.firstName || '',
            LastName: contact.lastName || '',
            Company: contact.company || '',
            VoiceId: template.voiceId || 'Joanna',
            // Pass the SSML to be spoken
            SSMLContent: template.ssmlContent || '<speak>Hello</speak>',
            VoicemailSSML: template.voicemailSsml || template.ssmlContent || '<speak>Hello</speak>',
            WorkspaceId: workspaceId
          };

          const response = await connectClient.send(new StartOutboundVoiceContactCommand({
            DestinationPhoneNumber: contact.phone,
            InstanceId: INSTANCE_ID,
            ContactFlowId: CONTACT_FLOW_ID,
            SourcePhoneNumber: sourcePhoneNumber,
            Attributes: contactAttributes,
          }));

          // Log campaign message (contact initiated)
          await db.insert(campaignMessages).values({
            campaignId,
            workspaceId,
            contactId: contact.contactId,
            channel: 'voice',
            status: 'queued', // Actual status updated by CTR stream later
            fromIdentity: sourcePhoneNumber,
            sentAt: new Date(),
            providerMessageId: response.ContactId,
          });

          delivered++; // Note: delivered here just means the call was successfully dispatched to Connect
        } catch (err: any) {
          console.error(`Failed to dispatch call to ${contact.phone}:`, err.message);
          
          await db.insert(campaignMessages).values({
            campaignId,
            workspaceId,
            contactId: contact.contactId,
            channel: 'voice',
            status: 'failed',
            fromIdentity: sourcePhoneNumber,
            errorCode: err.message?.substring(0, 100),
          });
        }
      }

      // 6. Complete Campaign Dispatch
      await db.update(campaigns).set({
        status: 'completed', // Dispatch completed, actual call results will come via stream
        completedAt: new Date(),
        totalRecipients: total,
      }).where(eq(campaigns.campaignId, campaignId));

      console.log(`Campaign ${campaignId} dispatch completed. Queued ${delivered}/${total} calls.`);
    } catch (err) {
      console.error('Error processing Voice SQS record:', err);
    }
  }
};
