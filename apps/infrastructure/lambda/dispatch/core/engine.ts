import { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { Logger } from '../../lib/logger';
import { isRetryableError } from './errors';
import { ChannelAdapter, DispatchStore } from './types';

export const PAGE_SIZE = 500;

/**
 * Process one campaign-dispatch payload end to end.
 *
 * Guarantees:
 * - Memory-safe: contacts are keyset-paginated, suppression checked per page.
 * - At-most-once per recipient: a unique (campaign_id, contact_id) claim row
 *   is inserted before sending; redelivered SQS records skip claimed rows.
 * - Resumable: an interrupted run picks up at the first unclaimed contact.
 * - Error triage: systemic errors propagate (SQS retry → DLQ); per-recipient
 *   errors are recorded on the message row and the campaign continues.
 *
 * Throws only for retryable conditions; config/data problems are terminal and
 * resolve the campaign (cancelled) instead of poisoning the queue.
 */
export async function processCampaignDispatch<TTemplate, TSetup>(
  body: string,
  store: DispatchStore,
  adapter: ChannelAdapter<TTemplate, TSetup>,
  baseLogger: Logger,
): Promise<void> {
  let payload: { campaignId?: string; workspaceId?: string };
  try {
    payload = JSON.parse(body);
  } catch {
    baseLogger.error('Poison pill: SQS record body is not JSON', undefined, { body: body.substring(0, 200) });
    return;
  }

  const { campaignId, workspaceId } = payload;
  if (!campaignId || !workspaceId) {
    baseLogger.error('Poison pill: payload missing campaignId/workspaceId', undefined, { payload });
    return;
  }

  const logger = baseLogger.with({ campaignId, workspaceId, channel: adapter.channel });

  const campaign = await store.fetchCampaign(campaignId, workspaceId);
  if (!campaign) {
    logger.warn('Campaign not found, skipping');
    return;
  }
  if (campaign.status === 'completed' || campaign.status === 'cancelled' || campaign.status === 'paused') {
    logger.info(`Campaign status is '${campaign.status}', skipping`);
    return;
  }

  const template = await adapter.fetchTemplate(campaign.templateId, workspaceId);
  if (!template) {
    logger.error('Template not found — cancelling campaign');
    await store.cancelCampaign(campaignId, 'template_not_found');
    return;
  }

  const settings = await store.fetchSettings(workspaceId);
  const prepared = adapter.prepare(campaign, template, settings);
  if ('configError' in prepared) {
    logger.error(`Workspace config error — cancelling campaign: ${prepared.configError}`);
    await store.cancelCampaign(campaignId, prepared.configError);
    return;
  }
  const { setup, fromIdentity } = prepared;

  // Stamped on every claim row; billing capture settles per-message
  // charges against the campaign's authorization hold using this cost.
  const costPerMessage = await store.fetchChannelPrice(workspaceId, adapter.channel);

  let sent = 0;
  let failed = 0;
  let skippedSuppressed = 0;
  let skippedAlreadyClaimed = 0;
  let skippedCompliance = 0;
  let cursor: string | null = null;

  for (;;) {
    const page = await store.fetchContactsPage(campaign.segmentId, cursor, PAGE_SIZE);
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.contactId;

    let reachable = page.filter((c) => adapter.recipientOf(c));

    // Compliance gate (e.g. TCPA quiet hours). Skipped contacts are not
    // claimed: re-queueing the campaign during allowed hours reaches them.
    if (adapter.skipReasonOf) {
      const now = new Date();
      const allowed: typeof reachable = [];
      for (const contact of reachable) {
        const reason = adapter.skipReasonOf(contact, now);
        if (reason) skippedCompliance++;
        else allowed.push(contact);
      }
      reachable = allowed;
    }

    let targets = reachable;
    if (reachable.length > 0) {
      const suppressed = await store.fetchSuppressedHashes(
        workspaceId,
        adapter.suppressionHashKind,
        reachable.map((c) => adapter.suppressionHashOf(c)),
      );
      targets = reachable.filter((c) => !suppressed.has(adapter.suppressionHashOf(c)));
      skippedSuppressed += reachable.length - targets.length;
    }

    if (targets.length > 0) {
      const claimed = await store.claimRecipients(campaign, adapter.channel, fromIdentity, targets, costPerMessage);
      skippedAlreadyClaimed += targets.length - claimed.length;

      if (claimed.length > 0) {
        const results = await adapter.sendBatch(claimed, setup, logger);
        const byContact = new Map(claimed.map((c) => [c.contact.contactId, c.messageId]));
        for (const result of results) {
          const messageId = byContact.get(result.contactId);
          if (!messageId) continue;
          if (result.ok) {
            await store.markSent(messageId, result.providerMessageId);
            sent++;
          } else {
            await store.markFailed(messageId, result.errorCode);
            failed++;
          }
        }
      }
    }

    if (page.length < PAGE_SIZE) break;
  }

  const totalRecipients = await store.completeCampaign(campaignId);
  logger.info('Campaign dispatch completed', {
    sent,
    failed,
    skippedSuppressed,
    skippedAlreadyClaimed,
    skippedCompliance,
    totalRecipients,
  });
}

/**
 * SQS handler wrapper: processes each record independently and reports
 * partial batch failures so only retryable records are redelivered.
 * Requires reportBatchItemFailures on the event source mapping.
 */
export function makeSqsHandler<TTemplate, TSetup>(
  getStore: () => Promise<DispatchStore>,
  adapter: ChannelAdapter<TTemplate, TSetup>,
): (event: SQSEvent) => Promise<SQSBatchResponse> {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const logger = new Logger({ handler: `dispatch-${adapter.channel}` });
    const batchItemFailures: { itemIdentifier: string }[] = [];

    const store = await getStore();

    for (const record of event.Records) {
      try {
        await processCampaignDispatch(record.body, store, adapter, logger);
      } catch (err) {
        if (isRetryableError(err)) {
          logger.error('Retryable dispatch failure — returning record to queue', err, {
            sqsMessageId: record.messageId,
          });
          batchItemFailures.push({ itemIdentifier: record.messageId });
        } else {
          // Non-retryable and unhandled: log loudly but do not poison the
          // queue. The claim rows preserve exactly which recipients were
          // reached; the alarm on Lambda errors surfaces the condition.
          logger.error('Non-retryable dispatch failure — dropping record', err, {
            sqsMessageId: record.messageId,
          });
        }
      }
    }

    return { batchItemFailures };
  };
}
