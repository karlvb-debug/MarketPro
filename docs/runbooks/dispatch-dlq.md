# Runbook: Dispatch DLQ / Lambda error alarms

Applies to the `Email|Sms|Voice DlqDepthAlarm` and `* DispatchErrorsAlarm`
CloudWatch alarms (published to the `marketing-saas-ops-alerts` SNS topic).

## What the alarm means

Each campaign send is one SQS message on a channel dispatch queue
(`EmailDispatchQueue`, `SmsDispatchQueue`, `VoiceDispatchQueue`). The dispatch
Lambda retries *retryable* failures (database down, provider throttling, 5xx)
via SQS redelivery; after `maxReceiveCount: 3` attempts the message lands in
the channel's DLQ and the alarm fires. A message in the DLQ means **a campaign
stopped mid-send and will not resume on its own**.

Non-retryable problems never reach the DLQ: invalid payloads are dropped with
an ERROR log, and missing templates/settings cancel the campaign.

## Safety properties you can rely on

- **No duplicate sends on redrive.** Every recipient is claimed with a unique
  `(campaign_id, contact_id)` row in `campaign_messages` before sending.
  Redriving a campaign message re-processes only unclaimed contacts.
- **Resumable.** Dispatch paginates contacts in order; a redriven message
  continues from wherever the claims stop.

## Diagnosis

1. Find the failure in CloudWatch Logs (log groups of
   `EmailDispatchFunction` / `SmsDispatchFunction` / `VoiceDispatchFunction`).
   Logs are structured JSON; filter with Logs Insights:
   ```
   fields @timestamp, level, message, campaignId, errorName, errorMessage
   | filter level = "ERROR"
   | sort @timestamp desc
   ```
2. Typical causes:
   - `RetryableDispatchError` wrapping SES/SMS/Connect throttling → provider
     quota issue; raise limits or wait, then redrive.
   - pg connection errors (codes `08xxx`, `53xxx`, `57xxx`) → check RDS health.
   - Sustained Lambda timeouts → segment too large for the 300s budget; see
     "Stuck campaigns" below.

## Redrive

After fixing the underlying cause, move messages back to the source queue
(DLQ redrive preserves the original payload):

```sh
aws sqs start-message-move-task \
  --source-arn <DLQ_ARN> \
  --destination-arn <SOURCE_QUEUE_ARN>
```

Queue URLs/ARNs are in the stack outputs (`EmailDispatchDlqUrl`, etc.).
Redriving is always safe with respect to duplicates (see safety properties).

## Stuck campaigns / stale claims

The claim-before-send design is **at-most-once**: if a Lambda dies between
claiming a recipient and sending, that recipient's row stays `queued` and is
intentionally never retried automatically. To find campaigns with stale
claims:

```sql
SELECT campaign_id, count(*)
FROM campaign_messages
WHERE status = 'queued' AND sent_at IS NULL
GROUP BY campaign_id;
```

For email/SMS, a `queued` row means the send was almost certainly never made
(the status update follows the provider call immediately). If you accept the
small risk of duplicates for those recipients, delete their `queued` rows and
redrive the campaign message — they will be re-claimed and sent:

```sql
DELETE FROM campaign_messages
WHERE campaign_id = '<id>' AND status = 'queued' AND sent_at IS NULL;
```

For voice, dial requests use `clientToken = message_id`, so redriving without
deleting rows is fully idempotent on the Connect side within the token window.

## A campaign shows 'sending' forever

If the SQS message was dropped as non-retryable (see ERROR logs) the campaign
may stay in `sending`. Re-queue it manually:

```sh
aws sqs send-message --queue-url <QUEUE_URL> \
  --message-body '{"campaignId":"<id>","workspaceId":"<wsid>"}'
```

Claims guarantee already-sent recipients are skipped.
