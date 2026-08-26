import { SNSEvent } from 'aws-lambda';

// ============================================
// Inbound SMS handler — two-way messaging + TCPA keyword compliance
// Subscribed to the InboundSmsTopic (AWS End User Messaging two-way config).
// Every inbound message lands in sms_inbox; STOP-family keywords feed the
// consent revocation chain immediately, START restores consent.
// ============================================

import { getPool } from './lib/db';
import { revokeConsent, restoreSmsConsent, phoneHashOf } from '@repo/core/consent';
import { Logger } from '@repo/core/logger';

export type KeywordType = 'STOP' | 'HELP' | 'START' | null;

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout']);
const START_WORDS = new Set(['start', 'unstop', 'subscribe', 'optin']);
const HELP_WORDS = new Set(['help', 'info']);

/** Classify a message body per CTIA/TCPA keyword rules. Pure. */
export function detectKeyword(body: string | null | undefined): KeywordType {
  const word = (body || '').trim().toLowerCase().replace(/[.!?]+$/, '');
  if (STOP_WORDS.has(word)) return 'STOP';
  if (START_WORDS.has(word)) return 'START';
  if (HELP_WORDS.has(word)) return 'HELP';
  return null;
}

export interface InboundSms {
  originationNumber: string;
  destinationNumber: string;
  messageBody: string;
}

/** Parse an End User Messaging inbound SNS message. Pure. */
export function parseInboundSms(snsMessage: string): InboundSms | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(snsMessage);
  } catch {
    return null;
  }
  const originationNumber = payload.originationNumber as string | undefined;
  const destinationNumber = payload.destinationNumber as string | undefined;
  if (!originationNumber || !destinationNumber) return null;
  return {
    originationNumber,
    destinationNumber,
    messageBody: (payload.messageBody as string | undefined) ?? '',
  };
}

export const handler = async (event: SNSEvent): Promise<void> => {
  const logger = new Logger({ handler: 'inbound-sms' });
  const pool = await getPool();

  for (const record of event.Records) {
    const inbound = parseInboundSms(record.Sns.Message);
    if (!inbound) {
      logger.warn('Unparseable inbound SMS payload', { snsMessageId: record.Sns.MessageId });
      continue;
    }

    const { originationNumber, destinationNumber, messageBody } = inbound;
    const keyword = detectKeyword(messageBody);

    // Resolve workspace by the number the message was sent TO
    const ws = await pool.query(
      `SELECT workspace_id FROM workspace_settings WHERE sms_phone_number = $1`,
      [destinationNumber],
    );
    if (ws.rows.length === 0) {
      logger.warn('Inbound SMS for unknown destination number', { destinationNumber });
      continue;
    }
    const workspaceId = ws.rows[0].workspace_id;
    const msgLogger = logger.with({ workspaceId, keyword });

    // Resolve contact by sender's phone (digits-only suffix match handles +1)
    const digits = originationNumber.replace(/\D/g, '');
    const contactRow = await pool.query(
      `SELECT contact_id FROM contacts
        WHERE workspace_id = $1 AND regexp_replace(phone, '\\D', '', 'g') = $2
        LIMIT 1`,
      [workspaceId, digits],
    );
    const contactId: string | null = contactRow.rows[0]?.contact_id ?? null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO sms_inbox (workspace_id, contact_id, from_number, to_number, body, is_keyword, keyword_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [workspaceId, contactId, originationNumber, destinationNumber, messageBody, keyword !== null, keyword],
      );

      if (keyword === 'STOP') {
        await revokeConsent(client, {
          workspaceId,
          contactId,
          channel: 'sms',
          email: null,
          phone: originationNumber,
          source: 'sms_stop_keyword',
        });
        msgLogger.info('STOP processed — phone suppressed', { phoneHash: phoneHashOf(originationNumber).substring(0, 8) });
      } else if (keyword === 'START') {
        await restoreSmsConsent(client, {
          workspaceId,
          contactId,
          phone: originationNumber,
          source: 'sms_start_keyword',
        });
        msgLogger.info('START processed — consent restored');
      } else {
        msgLogger.info('Inbound SMS logged');
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      msgLogger.error('Failed to process inbound SMS', err);
      throw err; // SNS retry
    } finally {
      client.release();
    }
  }
};
