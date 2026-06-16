import { SQSEvent, SQSBatchResponse, Context } from 'aws-lambda';
import { Logger } from '../../lib/logger';
import { isRetryableError } from './errors';
import { ChannelAdapter, DispatchStore } from './types';

export const PAGE_SIZE = 500;

// Leave headroom before the Lambda timeout to re-enqueue a continuation.
const TIME_BUFFER_MS = 30_000;
// Quiet-hours deferrals are retried on a delay (SQS max) until the window opens.
const QUIET_HOURS_RETRY_DELAY_S = 900;
// Safety cap (~25h at 15-min spacing) so a pathological deferral can't loop forever.
const MAX_QUIET_HOURS_REQUEUE = 100;

export interface DispatchPayload {
  campaignId?: string;
  workspaceId?: string;
  /** Keyset cursor for time-budget continuations (same pass, split across invocations). */
  afterContactId?: string | null;
  /** Number of quiet-hours full-rescan retries so far. */
  requeueCount?: number;
  /** True if any recipient was deferred (quiet hours) earlier in this pass. */
  deferredAny?: boolean;
}

export interface DispatchOptions {
  /** Re-enqueue a follow-up dispatch message to this channel's own queue. */
  requeue?: (payload: DispatchPayload, delaySeconds: number) => Promise<void>;
  /** Milliseconds left before the Lambda times out (default: unbounded). */
  timeRemainingMs?: () => number;
}

/**
 * Process one campaign-dispatch payload.
 *
 * Guarantees:
 * - Memory-safe: contacts are keyset-paginated, suppression checked per page.
 * - At-most-once per recipient: a unique (campaign_id, contact_id) claim row
 *   is inserted before sending; redelivered/continued records skip claimed rows.
 * - No per-campaign size ceiling: when the invocation nears its time budget it
 *   re-enqueues a continuation carrying the cursor, instead of relying on
 *   SQS visibility-timeout redelivery (which would hit maxReceiveCount → DLQ).
 * - Quiet-hours self-healing: recipients skipped for TCPA quiet hours are not
 *   claimed; if any were deferred, the campaign re-enqueues a full rescan on a
 *   delay and stays 'sending' until the window opens and everyone is reached.
 * - Error triage: systemic errors propagate (SQS retry → DLQ); per-recipient
 *   errors are recorded on the message row and the campaign continues.
 */
export async function processCampaignDispatch<TTemplate, TSetup>(
  body: string,
  store: DispatchStore,
  adapter: ChannelAdapter<TTemplate, TSetup>,
  baseLogger: Logger,
  options: DispatchOptions = {},
): Promise<void> {
  const requeue = options.requeue;
  const timeRemainingMs = options.timeRemainingMs ?? (() => Number.POSITIVE_INFINITY);

  let payload: DispatchPayload;
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
  const requeueCount = payload.requeueCount ?? 0;

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
  // Tracks quiet-hours deferrals across the whole pass (survives time-budget
  // continuations via the payload) so the final invocation knows to retry.
  let deferredAny = payload.deferredAny ?? false;
  let cursor: string | null = payload.afterContactId ?? null;

  for (;;) {
    const page = await store.fetchContactsPage(workspaceId, campaign.segmentId, cursor, PAGE_SIZE);
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.contactId;

    let reachable = page.filter((c) => adapter.recipientOf(c));

    // Compliance gate (e.g. TCPA quiet hours). Skipped contacts are NOT
    // claimed; a later full rescan (scheduled below) reaches them in-window.
    if (adapter.skipReasonOf) {
      const now = new Date();
      const allowed: typeof reachable = [];
      for (const contact of reachable) {
        const reason = adapter.skipReasonOf(contact, now);
        if (reason) { skippedCompliance++; deferredAny = true; }
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

    const morePages = page.length >= PAGE_SIZE;

    // Time-budget continuation: hand off the rest of THIS pass (same cursor,
    // same requeueCount) to a fresh invocation rather than risk a timeout.
    if (morePages && requeue && timeRemainingMs() < TIME_BUFFER_MS) {
      await requeue({ campaignId, workspaceId, afterContactId: cursor, requeueCount, deferredAny }, 0);
      logger.info('Time budget reached — continuation enqueued', { sent, failed, afterContactId: cursor });
      return;
    }

    if (!morePages) break;
  }

  // Quiet-hours self-heal: if anyone was deferred this pass, retry the whole
  // segment on a delay (claims make the rescan cheap) until the window opens.
  if (deferredAny && requeue && requeueCount < MAX_QUIET_HOURS_REQUEUE) {
    await requeue(
      { campaignId, workspaceId, requeueCount: requeueCount + 1, deferredAny: false },
      QUIET_HOURS_RETRY_DELAY_S,
    );
    logger.info('Quiet-hours deferrals — rescan scheduled', { sent, skippedCompliance, requeueCount: requeueCount + 1 });
    return;
  }

  const totalRecipients = await store.completeCampaign(campaignId);
  logger.info('Campaign dispatch completed', {
    sent,
    failed,
    skippedSuppressed,
    skippedAlreadyClaimed,
    skippedCompliance,
    totalRecipients,
    unreachedDeferrals: deferredAny && requeueCount >= MAX_QUIET_HOURS_REQUEUE,
  });
}

/**
 * SQS handler wrapper: processes each record independently, reports partial
 * batch failures (so only retryable records are redelivered), and gives the
 * engine a self-requeue + time budget for continuations. Requires
 * reportBatchItemFailures on the event source mapping and DISPATCH_QUEUE_URL
 * in the environment for continuations to be enqueued.
 */
export function makeSqsHandler<TTemplate, TSetup>(
  getStore: () => Promise<DispatchStore>,
  adapter: ChannelAdapter<TTemplate, TSetup>,
): (event: SQSEvent, context?: Context) => Promise<SQSBatchResponse> {
  return async (event: SQSEvent, context?: Context): Promise<SQSBatchResponse> => {
    const logger = new Logger({ handler: `dispatch-${adapter.channel}` });
    const batchItemFailures: { itemIdentifier: string }[] = [];

    const store = await getStore();
    const queueUrl = process.env.DISPATCH_QUEUE_URL;

    // Self-requeue via the channel's own queue (lazy SQS client).
    let requeue: DispatchOptions['requeue'];
    if (queueUrl) {
      requeue = async (payload, delaySeconds) => {
        const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
        const sqs = new SQSClient({});
        await sqs.send(new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(payload),
          DelaySeconds: Math.min(900, Math.max(0, Math.floor(delaySeconds))),
        }));
      };
    }
    const timeRemainingMs = context ? () => context.getRemainingTimeInMillis() : undefined;

    for (const record of event.Records) {
      try {
        await processCampaignDispatch(record.body, store, adapter, logger, { requeue, timeRemainingMs });
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
