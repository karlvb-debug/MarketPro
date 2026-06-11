import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '../../lib/db';
import {
  campaigns,
  contacts,
  contactSegment,
  campaignMessages,
  suppressionList,
  workspaceSettings,
} from '../../../drizzle/schema';
import {
  ClaimedRecipient,
  DispatchCampaign,
  DispatchContact,
  DispatchStore,
  WorkspaceDispatchSettings,
} from './types';

/** Production DispatchStore backed by the shared Drizzle/RDS client. */
export async function createDispatchStore(): Promise<DispatchStore> {
  const db = await getDb();

  return {
    async fetchCampaign(campaignId, workspaceId): Promise<DispatchCampaign | undefined> {
      const [row] = await db
        .select({
          campaignId: campaigns.campaignId,
          workspaceId: campaigns.workspaceId,
          templateId: campaigns.templateId,
          segmentId: campaigns.segmentId,
          status: campaigns.status,
        })
        .from(campaigns)
        .where(and(eq(campaigns.campaignId, campaignId), eq(campaigns.workspaceId, workspaceId)));
      return row;
    },

    async fetchSettings(workspaceId): Promise<WorkspaceDispatchSettings | undefined> {
      const [row] = await db
        .select({
          emailFromAddress: workspaceSettings.emailFromAddress,
          emailFromName: workspaceSettings.emailFromName,
          emailReplyTo: workspaceSettings.emailReplyTo,
          smsPhoneNumber: workspaceSettings.smsPhoneNumber,
          voicePhoneNumber: workspaceSettings.voicePhoneNumber,
        })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, workspaceId));
      return row;
    },

    async cancelCampaign(campaignId, reason): Promise<void> {
      // Reason is logged by the caller; the campaigns table has no error
      // column yet (candidate for M6 campaign detail view).
      void reason;
      await db
        .update(campaigns)
        .set({ status: 'cancelled' })
        .where(and(eq(campaigns.campaignId, campaignId), ne(campaigns.status, 'completed')));
    },

    async fetchContactsPage(segmentId, afterContactId, limit): Promise<DispatchContact[]> {
      const conditions = [
        eq(contactSegment.segmentId, segmentId),
        eq(contacts.status, 'active'),
      ];
      if (afterContactId) {
        conditions.push(gt(contacts.contactId, afterContactId));
      }
      const rows = await db
        .select({
          contactId: contacts.contactId,
          email: contacts.email,
          phone: contacts.phone,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          company: contacts.company,
        })
        .from(contactSegment)
        .innerJoin(contacts, eq(contactSegment.contactId, contacts.contactId))
        .where(and(...conditions))
        .orderBy(contacts.contactId)
        .limit(limit);
      return rows;
    },

    async fetchSuppressedHashes(workspaceId, kind, hashes): Promise<Set<string>> {
      if (hashes.length === 0) return new Set();
      const column = kind === 'email' ? suppressionList.emailHash : suppressionList.phoneHash;
      const rows = await db
        .select({ hash: column })
        .from(suppressionList)
        .where(and(eq(suppressionList.workspaceId, workspaceId), inArray(column, hashes)));
      return new Set(rows.map((r) => r.hash).filter((h): h is string => Boolean(h)));
    },

    async claimRecipients(campaign, channel, fromIdentity, batch): Promise<ClaimedRecipient[]> {
      if (batch.length === 0) return [];
      const inserted = await db
        .insert(campaignMessages)
        .values(
          batch.map((contact) => ({
            campaignId: campaign.campaignId,
            workspaceId: campaign.workspaceId,
            contactId: contact.contactId,
            channel,
            status: 'queued' as const,
            fromIdentity,
          })),
        )
        .onConflictDoNothing({
          target: [campaignMessages.campaignId, campaignMessages.contactId],
        })
        .returning({
          messageId: campaignMessages.messageId,
          contactId: campaignMessages.contactId,
        });

      const byContactId = new Map(batch.map((c) => [c.contactId, c]));
      return inserted.flatMap((row) => {
        const contact = row.contactId ? byContactId.get(row.contactId) : undefined;
        return contact ? [{ messageId: row.messageId, contact }] : [];
      });
    },

    async markSent(messageId, providerMessageId): Promise<void> {
      await db
        .update(campaignMessages)
        .set({ status: 'sent', sentAt: new Date(), providerMessageId })
        .where(eq(campaignMessages.messageId, messageId));
    },

    async markFailed(messageId, errorCode): Promise<void> {
      await db
        .update(campaignMessages)
        .set({ status: 'failed', errorCode: errorCode.substring(0, 100) })
        .where(eq(campaignMessages.messageId, messageId));
    },

    async completeCampaign(campaignId): Promise<number> {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(campaignMessages)
        .where(eq(campaignMessages.campaignId, campaignId));

      await db
        .update(campaigns)
        .set({ status: 'completed', completedAt: new Date(), totalRecipients: count })
        .where(and(eq(campaigns.campaignId, campaignId), ne(campaigns.status, 'cancelled')));

      return count;
    },
  };
}
