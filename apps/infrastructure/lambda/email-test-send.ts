import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { and, eq } from 'drizzle-orm';
import { getDb, respond, getWorkspaceId, getUserId, requireRole } from './lib/db';
import { emailTemplates, workspaceSettings } from '@repo/core/schema';
import { normalizeEmail } from '@repo/core/contact-validate';
import { mergeTags } from '@repo/core/dispatch/personalize';
import { DispatchContact } from '@repo/core/dispatch/types';
import { Logger } from '@repo/core/logger';

// ============================================
// Email test send — POST /email/test-send { templateId, to }
// Renders a saved template with sample merge-tag values and sends ONE email
// via SES to an arbitrary address. Deliberately bypasses segments, billing
// holds, and the suppression list — it's an internal preview, not a campaign.
// Rate-limited per workspace to protect sender reputation.
// ============================================

const ses = new SESv2Client({});
const TEST_SENDS_PER_MINUTE = 10;

// Sample contact used to resolve merge tags in the preview.
const SAMPLE_CONTACT: DispatchContact = {
  contactId: 'sample', email: '', phone: '+15555550123',
  firstName: 'Test', lastName: 'Recipient', company: 'Acme Inc', timezone: null,
};

/** Render a test email (subject prefixed, merge tags resolved with samples). Pure. */
export function renderTestEmail(
  subjectLine: string | null,
  htmlContent: string | null,
  to: string,
): { subject: string; html: string } {
  const contact = { ...SAMPLE_CONTACT, email: to };
  const subject = `[TEST] ${mergeTags(subjectLine || 'No Subject', contact)}`;
  const html = mergeTags(htmlContent || '<p>(This template has no content yet.)</p>', contact);
  return { subject, html };
}

/** Atomic per-workspace, per-minute counter on the DynamoDB idempotency table. */
async function withinRateLimit(workspaceId: string): Promise<boolean> {
  const table = process.env.IDEMPOTENCY_TABLE;
  if (!table) return true; // no table configured (e.g. local) → don't block
  const { DynamoDBClient, UpdateItemCommand } = await import('@aws-sdk/client-dynamodb');
  const ddb = new DynamoDBClient({});
  const bucket = Math.floor(Date.now() / 60_000);
  const ttl = Math.floor(Date.now() / 1000) + 120;
  const res = await ddb.send(new UpdateItemCommand({
    TableName: table,
    Key: { Message_ID: { S: `testsend:${workspaceId}:${bucket}` } },
    UpdateExpression: 'ADD cnt :one SET ttl = :ttl',
    ExpressionAttributeValues: { ':one': { N: '1' }, ':ttl': { N: String(ttl) } },
    ReturnValues: 'UPDATED_NEW',
  }));
  const count = parseInt(res.Attributes?.cnt?.N ?? '1', 10);
  return count <= TEST_SENDS_PER_MINUTE;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const logger = new Logger({ handler: 'email-test-send' });
  const userId = getUserId(event);
  if (!userId) return respond(401, { message: 'Unauthorized' });
  const workspaceId = getWorkspaceId(event);
  if (!workspaceId) return respond(400, { message: 'Missing X-Workspace-Id header' });

  // Editing rights are the bar for test sends.
  const denied = requireRole(event, 'editor');
  if (denied) return denied;

  const body = JSON.parse(event.body || '{}');
  const templateId = body.templateId || body.template_id;
  const to = normalizeEmail(body.to);
  if (!templateId) return respond(400, { message: 'templateId is required' });
  if (!to) return respond(400, { message: 'A valid recipient email is required' });

  try {
    if (!(await withinRateLimit(workspaceId))) {
      return respond(429, { message: `Test-send limit reached (${TEST_SENDS_PER_MINUTE}/min). Try again shortly.` });
    }

    const db = await getDb();
    const [template] = await db
      .select({ subjectLine: emailTemplates.subjectLine, htmlContent: emailTemplates.htmlContent })
      .from(emailTemplates)
      .where(and(eq(emailTemplates.templateId, templateId), eq(emailTemplates.workspaceId, workspaceId)));
    if (!template) return respond(404, { message: 'Template not found' });

    const [settings] = await db
      .select({
        fromAddress: workspaceSettings.emailFromAddress,
        fromName: workspaceSettings.emailFromName,
        replyTo: workspaceSettings.emailReplyTo,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId));

    const fromAddress = settings?.fromAddress || 'noreply@yourdomain.com';
    const fromName = settings?.fromName || 'Marketing SaaS';
    const replyTo = settings?.replyTo || fromAddress;
    const { subject, html } = renderTestEmail(template.subjectLine, template.htmlContent, to);

    await ses.send(new SendEmailCommand({
      FromEmailAddress: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
      ReplyToAddresses: [replyTo],
      Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: subject }, Body: { Html: { Data: html } } } },
    }));

    logger.info('Test email sent', { workspaceId, templateId, to });
    return respond(200, { sent: true, to });
  } catch (err) {
    logger.error('Test send failed', err, { workspaceId, templateId });
    return respond(502, { message: 'Failed to send test email. Check the workspace sending identity in Settings.' });
  }
};
