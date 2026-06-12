// Compliance integration tests against real Postgres: right-to-be-forgotten
// deletion matrix, one-click unsubscribe, and the SMS consent chain.
// Skipped unless TEST_DATABASE_URL is set.

import { Pool } from 'pg';
import { runMigrations } from '../lambda/lib/migrate';
import { executeRightToBeForgotten } from '../lambda/lib/gdpr';
import { performUnsubscribe, revokeConsent, restoreSmsConsent, emailHashOf, phoneHashOf } from '../lambda/lib/consent';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('compliance (Postgres integration)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  interface Fixture {
    workspaceId: string;
    contactId: string;
    segmentId: string;
    campaignId: string;
    messageId: string;
  }

  /** Workspace + contact with the full PII blast radius: segment membership,
   *  campaign message, both inboxes, a form submission. */
  async function makeFixture(email: string, phone: string): Promise<Fixture> {
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('t') RETURNING workspace_id`);
    const workspaceId = ws.rows[0].workspace_id;

    const c = await pool.query(
      `INSERT INTO contacts (workspace_id, email, phone, first_name, status)
       VALUES ($1, $2, $3, 'Ada', 'active') RETURNING contact_id`,
      [workspaceId, email, phone],
    );
    const contactId = c.rows[0].contact_id;

    const seg = await pool.query(
      `INSERT INTO segments (workspace_id, name) VALUES ($1, 's') RETURNING segment_id`,
      [workspaceId],
    );
    const segmentId = seg.rows[0].segment_id;
    await pool.query(`INSERT INTO contact_segment (contact_id, segment_id) VALUES ($1, $2)`, [contactId, segmentId]);

    const camp = await pool.query(
      `INSERT INTO campaigns (workspace_id, name, channel, template_id, segment_id, status)
       VALUES ($1, 'c', 'email', gen_random_uuid(), $2, 'completed') RETURNING campaign_id`,
      [workspaceId, segmentId],
    );
    const campaignId = camp.rows[0].campaign_id;

    const msg = await pool.query(
      `INSERT INTO campaign_messages (campaign_id, contact_id, workspace_id, channel, status)
       VALUES ($1, $2, $3, 'email', 'sent') RETURNING message_id`,
      [campaignId, contactId, workspaceId],
    );

    await pool.query(
      `INSERT INTO sms_inbox (workspace_id, contact_id, from_number, to_number, body)
       VALUES ($1, $2, $3, '+15550000000', 'my ssn is 123')`,
      [workspaceId, contactId, phone],
    );
    await pool.query(
      `INSERT INTO email_inbox (workspace_id, contact_id, from_address, subject, body)
       VALUES ($1, $2, $3, 'hello', 'private stuff')`,
      [workspaceId, contactId, email],
    );

    const form = await pool.query(
      `INSERT INTO web_forms (workspace_id, name) VALUES ($1, 'f') RETURNING form_id`,
      [workspaceId],
    );
    await pool.query(
      `INSERT INTO form_submissions (workspace_id, form_id, contact_id, form_data)
       VALUES ($1, $2, $3, '{"email":"raw-pii"}')`,
      [workspaceId, form.rows[0].form_id, contactId],
    );

    return { workspaceId, contactId, segmentId, campaignId, messageId: msg.rows[0].message_id };
  }

  describe('right to be forgotten', () => {
    test('executes the full deletion matrix transactionally', async () => {
      const email = 'forget.me@example.com';
      const phone = '+15551234567';
      const f = await makeFixture(email, phone);

      const result = await executeRightToBeForgotten(pool, f.workspaceId, f.contactId);

      expect(result).toMatchObject({
        deleted: true,
        suppressedEmail: true,
        suppressedPhone: true,
        redactedSmsInbox: 1,
        redactedEmailInbox: 1,
        deletedFormSubmissions: 1,
      });

      // Profile hard-deleted, segment membership cascaded
      const contact = await pool.query(`SELECT 1 FROM contacts WHERE contact_id = $1`, [f.contactId]);
      expect(contact.rows).toHaveLength(0);
      const membership = await pool.query(`SELECT 1 FROM contact_segment WHERE contact_id = $1`, [f.contactId]);
      expect(membership.rows).toHaveLength(0);

      // Suppression hashes retained
      const sup = await pool.query(
        `SELECT reason FROM suppression_list WHERE workspace_id = $1 AND email_hash = $2 AND phone_hash = $3`,
        [f.workspaceId, emailHashOf(email), phoneHashOf(phone)],
      );
      expect(sup.rows[0].reason).toBe('gdpr_delete');

      // Aggregates anonymized, not deleted
      const msg = await pool.query(`SELECT contact_id FROM campaign_messages WHERE message_id = $1`, [f.messageId]);
      expect(msg.rows[0].contact_id).toBeNull();

      // Inboxes redacted but preserved
      const sms = await pool.query(`SELECT from_number, body FROM sms_inbox WHERE workspace_id = $1`, [f.workspaceId]);
      expect(sms.rows[0]).toEqual({ from_number: 'REDACTED', body: null });
      const mail = await pool.query(`SELECT from_address, subject, body FROM email_inbox WHERE workspace_id = $1`, [f.workspaceId]);
      expect(mail.rows[0]).toEqual({ from_address: 'redacted@gdpr.invalid', subject: null, body: null });

      // Form submissions hard-deleted
      const subs = await pool.query(`SELECT 1 FROM form_submissions WHERE workspace_id = $1`, [f.workspaceId]);
      expect(subs.rows).toHaveLength(0);
    });

    test('tenant isolation: wrong workspace cannot erase the contact', async () => {
      const f = await makeFixture('isolated@example.com', '+15559990000');
      const otherWs = await pool.query(`INSERT INTO workspaces (name) VALUES ('other') RETURNING workspace_id`);

      const result = await executeRightToBeForgotten(pool, otherWs.rows[0].workspace_id, f.contactId);

      expect(result).toBeNull();
      const contact = await pool.query(`SELECT 1 FROM contacts WHERE contact_id = $1`, [f.contactId]);
      expect(contact.rows).toHaveLength(1);
    });

    test('is idempotent: second call reports not found', async () => {
      const f = await makeFixture('twice@example.com', '+15558880000');
      await executeRightToBeForgotten(pool, f.workspaceId, f.contactId);
      expect(await executeRightToBeForgotten(pool, f.workspaceId, f.contactId)).toBeNull();
    });
  });

  describe('one-click unsubscribe', () => {
    test('suppresses, unsubscribes, and writes consent evidence', async () => {
      const email = 'unsub@example.com';
      const f = await makeFixture(email, '+15557770000');

      const result = await performUnsubscribe(pool, f.messageId);
      expect(result).toEqual({ ok: true });

      const contact = await pool.query(`SELECT status FROM contacts WHERE contact_id = $1`, [f.contactId]);
      expect(contact.rows[0].status).toBe('unsubscribed');

      const sup = await pool.query(
        `SELECT reason FROM suppression_list WHERE workspace_id = $1 AND email_hash = $2`,
        [f.workspaceId, emailHashOf(email)],
      );
      expect(sup.rows[0].reason).toBe('unsubscribe');

      const ledger = await pool.query(
        `SELECT consent_type, channel, source FROM consent_ledger WHERE contact_id = $1`,
        [f.contactId],
      );
      expect(ledger.rows[0]).toEqual({ consent_type: 'opt_out', channel: 'email', source: 'one_click_unsubscribe' });

      const msg = await pool.query(`SELECT status FROM campaign_messages WHERE message_id = $1`, [f.messageId]);
      expect(msg.rows[0].status).toBe('unsubscribed');
    });

    test('is idempotent and rejects unknown tokens', async () => {
      const f = await makeFixture('unsub2@example.com', '+15556660000');
      await performUnsubscribe(pool, f.messageId);

      expect(await performUnsubscribe(pool, f.messageId)).toEqual({ ok: true, alreadyUnsubscribed: true });
      expect(await performUnsubscribe(pool, '00000000-0000-4000-8000-000000000000')).toEqual({ ok: false });
    });
  });

  describe('SMS consent chain (STOP / START)', () => {
    test('revoke then restore round-trips suppression and ledger evidence', async () => {
      const phone = '+15553330000';
      const f = await makeFixture('sms@example.com', phone);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await revokeConsent(client, {
          workspaceId: f.workspaceId,
          contactId: f.contactId,
          channel: 'sms',
          email: null,
          phone,
          source: 'sms_stop_keyword',
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      expect(
        (await pool.query(`SELECT status FROM contacts WHERE contact_id = $1`, [f.contactId])).rows[0].status,
      ).toBe('unsubscribed');
      expect(
        (await pool.query(
          `SELECT 1 FROM suppression_list WHERE workspace_id = $1 AND phone_hash = $2`,
          [f.workspaceId, phoneHashOf(phone)],
        )).rows,
      ).toHaveLength(1);

      const client2 = await pool.connect();
      try {
        await client2.query('BEGIN');
        await restoreSmsConsent(client2, {
          workspaceId: f.workspaceId,
          contactId: f.contactId,
          phone,
          source: 'sms_start_keyword',
        });
        await client2.query('COMMIT');
      } finally {
        client2.release();
      }

      expect(
        (await pool.query(`SELECT status FROM contacts WHERE contact_id = $1`, [f.contactId])).rows[0].status,
      ).toBe('active');
      expect(
        (await pool.query(
          `SELECT 1 FROM suppression_list WHERE workspace_id = $1 AND phone_hash = $2`,
          [f.workspaceId, phoneHashOf(phone)],
        )).rows,
      ).toHaveLength(0);

      const ledger = await pool.query(
        `SELECT consent_type FROM consent_ledger WHERE contact_id = $1 ORDER BY created_at`,
        [f.contactId],
      );
      expect(ledger.rows.map((r) => r.consent_type)).toEqual(['opt_out', 'opt_in']);
    });
  });
});
