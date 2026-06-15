// Engagement rollups + timeline against real Postgres. Skipped unless
// TEST_DATABASE_URL is set.

import { Pool } from 'pg';
import * as crypto from 'crypto';
import { runMigrations } from '../lambda/lib/migrate';
import { recordEngagement, recordSent } from '../lambda/lib/engagement';
import { buildContactTimeline, getConsentState } from '../lambda/lib/timeline';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('engagement rollups + timeline (Postgres integration)', () => {
  let pool: Pool;
  let workspaceId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await runMigrations(pool);
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('eng') RETURNING workspace_id`);
    workspaceId = ws.rows[0].workspace_id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeContactWithMessage(email: string) {
    const c = await pool.query(
      `INSERT INTO contacts (workspace_id, email, status) VALUES ($1, $2, 'active') RETURNING contact_id`,
      [workspaceId, email],
    );
    const contactId = c.rows[0].contact_id;
    const seg = await pool.query(
      `INSERT INTO segments (workspace_id, name) VALUES ($1, 's') RETURNING segment_id`,
      [workspaceId],
    );
    const camp = await pool.query(
      `INSERT INTO campaigns (workspace_id, name, channel, template_id, segment_id, status)
       VALUES ($1, 'Spring Sale', 'email', gen_random_uuid(), $2, 'completed') RETURNING campaign_id`,
      [workspaceId, seg.rows[0].segment_id],
    );
    const msg = await pool.query(
      `INSERT INTO campaign_messages (campaign_id, contact_id, workspace_id, channel, status)
       VALUES ($1, $2, $3, 'email', 'queued') RETURNING message_id`,
      [camp.rows[0].campaign_id, contactId, workspaceId],
    );
    return { contactId, messageId: msg.rows[0].message_id };
  }

  async function rollup(contactId: string) {
    const r = await pool.query(
      `SELECT total_sent, total_delivered, total_opened, total_clicked,
              last_sent_at, last_engaged_at FROM contacts WHERE contact_id = $1`,
      [contactId],
    );
    return r.rows[0];
  }

  test('sent → delivered → opened → clicked increments each counter once', async () => {
    const { contactId, messageId } = await makeContactWithMessage('flow@x.com');

    expect(await recordSent(pool, messageId)).toBe(true);
    expect(await recordEngagement(pool, messageId, 'delivered')).toBe(true);
    expect(await recordEngagement(pool, messageId, 'opened')).toBe(true);
    expect(await recordEngagement(pool, messageId, 'clicked')).toBe(true);

    const r = await rollup(contactId);
    expect(r.total_sent).toBe(1);
    expect(r.total_delivered).toBe(1);
    expect(r.total_opened).toBe(1);
    expect(r.total_clicked).toBe(1);
    expect(r.last_sent_at).not.toBeNull();
    expect(r.last_engaged_at).not.toBeNull();
  });

  test('duplicate events are idempotent (count once per message)', async () => {
    const { contactId, messageId } = await makeContactWithMessage('dup@x.com');

    expect(await recordSent(pool, messageId)).toBe(true);
    expect(await recordSent(pool, messageId)).toBe(false); // already sent
    expect(await recordEngagement(pool, messageId, 'opened')).toBe(true);
    expect(await recordEngagement(pool, messageId, 'opened')).toBe(false); // already opened

    const r = await rollup(contactId);
    expect(r.total_sent).toBe(1);
    expect(r.total_opened).toBe(1);
  });

  test('delivery does not advance last_engaged_at; opens/clicks do', async () => {
    const { contactId, messageId } = await makeContactWithMessage('eng@x.com');
    await recordEngagement(pool, messageId, 'delivered');
    expect((await rollup(contactId)).last_engaged_at).toBeNull();
    await recordEngagement(pool, messageId, 'opened');
    expect((await rollup(contactId)).last_engaged_at).not.toBeNull();
  });

  test('rollups feed engagement-based rule filtering', async () => {
    const { contactId, messageId } = await makeContactWithMessage('seg@x.com');
    await recordEngagement(pool, messageId, 'opened');
    // contact has total_opened >= 1
    const opened = await pool.query(
      `SELECT COUNT(*)::int AS n FROM contacts c
        WHERE c.workspace_id = $1 AND c.total_opened > 0 AND c.contact_id = $2`,
      [workspaceId, contactId],
    );
    expect(opened.rows[0].n).toBe(1);
  });

  test('timeline merges messages and consent in reverse-chronological order', async () => {
    const { contactId, messageId } = await makeContactWithMessage('tl@x.com');
    await recordSent(pool, messageId);
    await recordEngagement(pool, messageId, 'delivered');
    await pool.query(
      `INSERT INTO consent_ledger (contact_id, workspace_id, channel, consent_type, source)
       VALUES ($1, $2, 'email', 'opt_out', 'one_click_unsubscribe')`,
      [contactId, workspaceId],
    );

    const page = await buildContactTimeline(pool, workspaceId, contactId, null, 30);
    expect(page.events.length).toBeGreaterThanOrEqual(2);
    const types = page.events.map((e) => e.type);
    expect(types).toContain('message');
    expect(types).toContain('consent');
    const msgEvent = page.events.find((e) => e.type === 'message');
    expect(msgEvent?.campaignName).toBe('Spring Sale');
    // sorted descending by timestamp
    for (let i = 1; i < page.events.length; i++) {
      expect(page.events[i - 1]!.at >= page.events[i]!.at).toBe(true);
    }
  });

  test('consent state reflects suppression + ledger', async () => {
    const { contactId } = await makeContactWithMessage('consent@x.com');
    const emailHash = crypto.createHash('sha256').update('consent@x.com').digest('hex');
    await pool.query(
      `INSERT INTO suppression_list (workspace_id, email_hash, reason) VALUES ($1, $2, 'unsubscribe')`,
      [workspaceId, emailHash],
    );
    await pool.query(
      `INSERT INTO consent_ledger (contact_id, workspace_id, channel, consent_type, source)
       VALUES ($1, $2, 'email', 'opt_out', 'one_click_unsubscribe')`,
      [contactId, workspaceId],
    );

    const state = await getConsentState(pool, workspaceId, contactId);
    expect(state.email.suppressed).toBe(true);
    expect(state.email.reason).toBe('unsubscribe');
    expect(state.phone.suppressed).toBe(false);
    expect(state.ledger[0]?.consentType).toBe('opt_out');
  });

  test('timeline excludes anonymized (SET NULL) rows', async () => {
    const { contactId, messageId } = await makeContactWithMessage('gone@x.com');
    await recordEngagement(pool, messageId, 'delivered');
    // simulate GDPR anonymization
    await pool.query(`UPDATE campaign_messages SET contact_id = NULL WHERE message_id = $1`, [messageId]);
    const page = await buildContactTimeline(pool, workspaceId, contactId, null, 30);
    expect(page.events.filter((e) => e.type === 'message')).toHaveLength(0);
  });
});
