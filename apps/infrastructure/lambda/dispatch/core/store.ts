import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb, getPool } from '../../lib/db';
import { DEFAULT_CHANNEL_PRICES } from '../../lib/billing';
import { buildMembershipClause, loadSegment, SegmentRow, MembershipClause } from '../../lib/segment-query';
import { recordSent } from '../../lib/engagement';
import {
  campaigns,
  contacts,
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
  const pool = await getPool();

  // Resolve a segment's membership predicate once per invocation; dispatch
  // calls fetchContactsPage repeatedly with the same segmentId.
  const clauseCache = new Map<string, MembershipClause | null>();
  async function membershipFor(workspaceId: string, segmentId: string): Promise<MembershipClause | null> {
    const cached = clauseCache.get(segmentId);
    if (cached !== undefined) return cached;
    const segment: SegmentRow | null = await loadSegment(pool, workspaceId, segmentId);
    const clause = segment ? await buildMembershipClause(pool, segment, 2) : null;
    clauseCache.set(segmentId, clause);
    return clause;
  }

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

    async fetchContactsPage(workspaceId, segmentId, afterContactId, limit): Promise<DispatchContact[]> {
      const clause = await membershipFor(workspaceId, segmentId);
      if (!clause) return []; // segment no longer exists
      const pageSize = Math.max(1, Math.min(2000, Math.floor(limit)));
      const result = await pool.query(
        `SELECT c.contact_id AS "contactId", c.email, c.phone,
                c.first_name AS "firstName", c.last_name AS "lastName",
                c.company, c.timezone
           FROM contacts c
          WHERE c.workspace_id = $1
            AND ($2::uuid IS NULL OR c.contact_id > $2)
            AND c.status = 'active'
            AND ${clause.text}
          ORDER BY c.contact_id
          LIMIT ${pageSize}`,
        [workspaceId, afterContactId, ...clause.params],
      );
      return result.rows;
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

    async fetchChannelPrice(workspaceId, channel): Promise<string> {
      const [row] = await db
        .select({
          email: workspaceSettings.pricePerEmail,
          sms: workspaceSettings.pricePerSms,
          voice: workspaceSettings.pricePerVoice,
        })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, workspaceId));
      return row?.[channel] ?? DEFAULT_CHANNEL_PRICES[channel];
    },

    async claimRecipients(campaign, channel, fromIdentity, batch, costPerMessage): Promise<ClaimedRecipient[]> {
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
            cost: costPerMessage,
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
      // Bump the contact's total_sent/last_sent_at rollup the first time the
      // message is sent (gated on sent_at IS NULL), then stamp the row. Order
      // matters: recordSent must see sent_at NULL to count.
      await recordSent(pool, messageId);
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
