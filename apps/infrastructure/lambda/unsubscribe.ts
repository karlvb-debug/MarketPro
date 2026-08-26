import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// ============================================
// Public unsubscribe endpoint (no auth — the token IS the credential)
// POST /unsubscribe?token=...  — RFC 8058 One-Click (mail clients)
// GET  /unsubscribe?token=...  — footer link (humans), returns HTML
// Token = campaign_messages UUID embedded in the outgoing email headers.
// ============================================

import { getPool } from './lib/db';
import { performUnsubscribe } from '@repo/core/consent';
import { Logger } from '@repo/core/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONFIRMATION_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Unsubscribed</title></head>
<body style="font-family:sans-serif;text-align:center;padding:4rem">
<h1>You're unsubscribed</h1>
<p>You will no longer receive emails from this sender.</p>
</body></html>`;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const logger = new Logger({ handler: 'unsubscribe' });
  const token = event.queryStringParameters?.token;
  const isGet = event.httpMethod === 'GET';

  const reply = (statusCode: number, html: boolean, body: string): APIGatewayProxyResult => ({
    statusCode,
    headers: { 'Content-Type': html ? 'text/html' : 'application/json' },
    body,
  });

  if (!token || !UUID_RE.test(token)) {
    return reply(400, isGet, isGet ? '<h1>Invalid unsubscribe link</h1>' : JSON.stringify({ message: 'Invalid token' }));
  }

  try {
    const pool = await getPool();
    const result = await performUnsubscribe(pool, token);

    if (!result.ok) {
      // Unknown token: do NOT reveal whether it ever existed
      return reply(404, isGet, isGet ? '<h1>Invalid unsubscribe link</h1>' : JSON.stringify({ message: 'Invalid token' }));
    }

    logger.info('Unsubscribe processed', { alreadyUnsubscribed: result.alreadyUnsubscribed ?? false });
    return reply(200, isGet, isGet ? CONFIRMATION_HTML : JSON.stringify({ unsubscribed: true }));
  } catch (err) {
    logger.error('Unsubscribe failed', err);
    return reply(500, isGet, isGet ? '<h1>Something went wrong — please try again</h1>' : JSON.stringify({ message: 'Internal error' }));
  }
};
