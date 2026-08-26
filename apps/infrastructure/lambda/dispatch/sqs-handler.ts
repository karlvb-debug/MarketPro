// ============================================
// SQS transport adapter for the dispatch engine.
//
// The engine itself is transport-agnostic and lives in @repo/core; this file
// is the only thing that knows about SQS. M4 replaces it with a cron/pg-boss
// handler by supplying a different `requeue` + time budget to the same engine.
// ============================================

import { SQSEvent, SQSBatchResponse, Context } from 'aws-lambda';
import { Logger } from '@repo/core/logger';
import { isRetryableError } from '@repo/core/dispatch/errors';
import { processCampaignDispatch, type DispatchOptions } from '@repo/core/dispatch/engine';
import { ChannelAdapter, DispatchStore } from '@repo/core/dispatch/types';

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
