// Contact merge + dedup + bulk ops against real Postgres. Skipped unless
// TEST_DATABASE_URL is set.

import { Pool } from 'pg';
import { runMigrations } from '../lambda/lib/migrate';
import { mergeContacts } from '../lambda/lib/merge';
import { findDuplicateClusters } from '../lambda/lib/duplicates';
import { applyBulkAction } from '../lambda/lib/bulk';
import { executeRightToBeForgotten } from '../lambda/lib/gdpr';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('contact merge / dedup / bulk (Postgres integration)', () => {
  let pool: Pool;
  let workspaceId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await runMigrations(pool);
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('merge') RETURNING workspace_id`);
    workspaceId = ws.rows[0].workspace_id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeContact(fields: Partial<{ email: string; phone: string; firstName: string; company: string; status: string; custom: object }>) {
    const r = await pool.query(
      `INSERT INTO contacts (workspace_id, email, phone, first_name, company, status, custom_fields)
       VALUES ($1, $2, $3, $4, $5, $6::contact_status, $7) RETURNING contact_id`,
      [workspaceId, fields.email ?? null, fields.phone ?? null, fields.firstName ?? null,
       fields.company ?? null, fields.status ?? 'active', JSON.stringify(fields.custom ?? {})],
    );
    return r.rows[0].contact_id;
  }

  async function makeSegment() {
    const r = await pool.query(`INSERT INTO segments (workspace_id, name) VALUES ($1, 's') RETURNING segment_id`, [workspaceId]);
    return r.rows[0].segment_id;
  }

  async function makeCampaign(segmentId: string) {
    const r = await pool.query(
      `INSERT INTO campaigns (workspace_id, name, channel, template_id, segment_id, status)
       VALUES ($1, 'c', 'email', gen_random_uuid(), $2, 'completed') RETURNING campaign_id`,
      [workspaceId, segmentId],
    );
    return r.rows[0].campaign_id;
  }

  describe('merge', () => {
    test('folds field gaps, unions segments, repoints history, recomputes rollups', async () => {
      const seg1 = await makeSegment();
      const seg2 = await makeSegment();
      const survivor = await makeContact({ email: 'keep@x.com', firstName: 'Ada', custom: { plan: 'pro' } });
      const dup = await makeContact({ phone: '+15551112222', company: 'Acme', custom: { tier: 'gold' } });

      await pool.query(`INSERT INTO contact_segment (contact_id, segment_id) VALUES ($1, $2)`, [survivor, seg1]);
      await pool.query(`INSERT INTO contact_segment (contact_id, segment_id) VALUES ($1, $2)`, [dup, seg2]);

      // dup has an opened message in its own campaign
      const camp = await makeCampaign(seg2);
      await pool.query(
        `INSERT INTO campaign_messages (campaign_id, contact_id, workspace_id, channel, status, sent_at, opened_at)
         VALUES ($1, $2, $3, 'email', 'opened', NOW(), NOW())`,
        [camp, dup, workspaceId],
      );
      await pool.query(
        `INSERT INTO consent_ledger (contact_id, workspace_id, channel, consent_type, source)
         VALUES ($1, $2, 'sms', 'opt_in', 'import')`,
        [dup, workspaceId],
      );

      const result = await mergeContacts(pool, workspaceId, survivor, [dup], 'user-1');
      expect(result).toEqual({ survivorId: survivor, mergedCount: 1 });

      // duplicate gone
      expect((await pool.query(`SELECT 1 FROM contacts WHERE contact_id = $1`, [dup])).rows).toHaveLength(0);

      // survivor filled blanks (phone, company) and kept its own (email, firstName)
      const s = (await pool.query(
        `SELECT email, phone, first_name, company, custom_fields, total_opened FROM contacts WHERE contact_id = $1`,
        [survivor],
      )).rows[0];
      expect(s).toMatchObject({ email: 'keep@x.com', phone: '+15551112222', first_name: 'Ada', company: 'Acme' });
      expect(s.custom_fields).toEqual({ plan: 'pro', tier: 'gold' });

      // segments unioned
      const segs = (await pool.query(`SELECT segment_id FROM contact_segment WHERE contact_id = $1`, [survivor])).rows;
      expect(segs).toHaveLength(2);

      // message + consent repointed; rollups recomputed
      expect((await pool.query(`SELECT contact_id FROM campaign_messages WHERE campaign_id = $1`, [camp])).rows[0].contact_id).toBe(survivor);
      expect((await pool.query(`SELECT contact_id FROM consent_ledger WHERE source = 'import' AND workspace_id = $1`, [workspaceId])).rows[0].contact_id).toBe(survivor);
      expect(s.total_opened).toBe(1);

      // audit row written
      const log = (await pool.query(`SELECT survivor_id, merged_ids FROM contact_merge_log WHERE workspace_id = $1`, [workspaceId])).rows[0];
      expect(log.survivor_id).toBe(survivor);
      expect(log.merged_ids).toEqual([dup]);
    });

    test('inherits the most-restrictive consent status', async () => {
      const survivor = await makeContact({ email: 'a@x.com', status: 'active' });
      const dup = await makeContact({ phone: '+15553334444', status: 'unsubscribed' });
      await mergeContacts(pool, workspaceId, survivor, [dup], 'u');
      expect((await pool.query(`SELECT status FROM contacts WHERE contact_id = $1`, [survivor])).rows[0].status).toBe('unsubscribed');
    });

    test('respects the (campaign_id, contact_id) unique index — collisions are dropped', async () => {
      const seg = await makeSegment();
      const camp = await makeCampaign(seg);
      const survivor = await makeContact({ email: 'sv@x.com' });
      const dup = await makeContact({ email: 'dp@x.com' });
      // both received the SAME campaign
      await pool.query(`INSERT INTO campaign_messages (campaign_id, contact_id, workspace_id, channel, status, sent_at) VALUES ($1,$2,$3,'email','delivered',NOW()),($1,$4,$3,'email','sent',NOW())`,
        [camp, survivor, workspaceId, dup]);

      const result = await mergeContacts(pool, workspaceId, survivor, [dup], 'u');
      expect('survivorId' in result).toBe(true);
      // survivor keeps exactly one message row for that campaign (no constraint violation)
      const msgs = (await pool.query(`SELECT COUNT(*)::int AS n FROM campaign_messages WHERE campaign_id = $1 AND contact_id = $2`, [camp, survivor])).rows[0];
      expect(msgs.n).toBe(1);
    });

    test('rejects survivor listed among duplicates, and missing ids', async () => {
      const survivor = await makeContact({ email: 's2@x.com' });
      expect(await mergeContacts(pool, workspaceId, survivor, [survivor], 'u')).toEqual({ ok: false, reason: 'survivor_in_duplicates' });
      const missing = '00000000-0000-4000-8000-000000000000';
      expect(await mergeContacts(pool, workspaceId, survivor, [missing], 'u')).toMatchObject({ ok: false, reason: 'duplicates_not_found' });
    });

    test('tenant isolation: cannot merge across workspaces', async () => {
      const other = (await pool.query(`INSERT INTO workspaces (name) VALUES ('o') RETURNING workspace_id`)).rows[0].workspace_id;
      const survivor = await makeContact({ email: 'iso@x.com' });
      const foreignDup = (await pool.query(
        `INSERT INTO contacts (workspace_id, email, status) VALUES ($1, 'f@x.com', 'active') RETURNING contact_id`,
        [other],
      )).rows[0].contact_id;
      expect(await mergeContacts(pool, workspaceId, survivor, [foreignDup], 'u')).toMatchObject({ ok: false, reason: 'duplicates_not_found' });
    });

    test('merged survivor can still be GDPR-erased afterward', async () => {
      const survivor = await makeContact({ email: 'gdpr@x.com' });
      const dup = await makeContact({ phone: '+15556667777' });
      await mergeContacts(pool, workspaceId, survivor, [dup], 'u');
      const erased = await executeRightToBeForgotten(pool, workspaceId, survivor);
      expect(erased?.deleted).toBe(true);
      expect((await pool.query(`SELECT 1 FROM contacts WHERE contact_id = $1`, [survivor])).rows).toHaveLength(0);
    });
  });

  describe('duplicate detection', () => {
    test('clusters case/format variants by normalized email and phone', async () => {
      const localWs = (await pool.query(`INSERT INTO workspaces (name) VALUES ('dd') RETURNING workspace_id`)).rows[0].workspace_id;
      const mk = (email: string | null, phone: string | null) =>
        pool.query(`INSERT INTO contacts (workspace_id, email, phone, status) VALUES ($1,$2,$3,'active')`, [localWs, email, phone]);
      // Two emails that normalize the same (case), two phones that normalize the same (format)
      await mk('Dupe@X.com', null);
      await mk('dupe@x.com ', null);
      // Both normalize to 11 digits '15558880000' (with country code).
      await mk(null, '1 (555) 888-0000');
      await mk(null, '+1 555 888 0000');
      await mk('unique@x.com', null);

      const clusters = await findDuplicateClusters(pool, localWs);
      const emailCluster = clusters.find((c) => c.keyType === 'email' && c.key === 'dupe@x.com');
      const phoneCluster = clusters.find((c) => c.keyType === 'phone' && c.key === '15558880000');
      expect(emailCluster?.contactIds).toHaveLength(2);
      expect(phoneCluster?.contactIds).toHaveLength(2);
    });
  });

  describe('bulk operations', () => {
    test('rule selection: bulk unsubscribe sets status, ledger, and suppression', async () => {
      const localWs = (await pool.query(`INSERT INTO workspaces (name) VALUES ('bulk1') RETURNING workspace_id`)).rows[0].workspace_id;
      await pool.query(`INSERT INTO custom_field_definitions (workspace_id, name, key, type, options) VALUES ($1,'Plan','plan','select',$2)`, [localWs, JSON.stringify(['free', 'pro'])]);
      const pro1 = (await pool.query(`INSERT INTO contacts (workspace_id, email, status, custom_fields) VALUES ($1,'p1@x.com','active','{"plan":"pro"}') RETURNING contact_id`, [localWs])).rows[0].contact_id;
      await pool.query(`INSERT INTO contacts (workspace_id, email, status, custom_fields) VALUES ($1,'f1@x.com','active','{"plan":"free"}')`, [localWs]);

      const res = await applyBulkAction(pool, localWs,
        { rules: { combinator: 'and', conditions: [{ field: 'custom.plan', op: 'eq', value: 'pro' }] } },
        { type: 'unsubscribe' }, 'admin-1');
      expect(res.affected).toBe(1);

      expect((await pool.query(`SELECT status FROM contacts WHERE contact_id = $1`, [pro1])).rows[0].status).toBe('unsubscribed');
      const led = await pool.query(`SELECT source FROM consent_ledger WHERE contact_id = $1`, [pro1]);
      expect(led.rows[0].source).toBe('bulk_unsubscribe:admin-1');
      const sup = await pool.query(
        `SELECT 1 FROM suppression_list WHERE workspace_id = $1 AND email_hash = encode(digest('p1@x.com','sha256'),'hex')`,
        [localWs],
      );
      expect(sup.rows).toHaveLength(1);
      // free contact untouched
      expect((await pool.query(`SELECT status FROM contacts WHERE email = 'f1@x.com'`)).rows[0].status).toBe('active');
    });

    test('id selection: bulk add to a static segment (idempotent)', async () => {
      const localWs = (await pool.query(`INSERT INTO workspaces (name) VALUES ('bulk2') RETURNING workspace_id`)).rows[0].workspace_id;
      const seg = (await pool.query(`INSERT INTO segments (workspace_id, name, kind) VALUES ($1,'s','static') RETURNING segment_id`, [localWs])).rows[0].segment_id;
      const c1 = (await pool.query(`INSERT INTO contacts (workspace_id, email, status) VALUES ($1,'b1@x.com','active') RETURNING contact_id`, [localWs])).rows[0].contact_id;
      const c2 = (await pool.query(`INSERT INTO contacts (workspace_id, email, status) VALUES ($1,'b2@x.com','active') RETURNING contact_id`, [localWs])).rows[0].contact_id;

      const r1 = await applyBulkAction(pool, localWs, { contactIds: [c1, c2] }, { type: 'add_segment', segmentId: seg }, 'u');
      expect(r1.affected).toBe(2);
      // re-run is idempotent (ON CONFLICT DO NOTHING)
      const r2 = await applyBulkAction(pool, localWs, { contactIds: [c1, c2] }, { type: 'add_segment', segmentId: seg }, 'u');
      expect(r2.affected).toBe(0);
    });

    test('bulk set_custom_field validates and coerces', async () => {
      const localWs = (await pool.query(`INSERT INTO workspaces (name) VALUES ('bulk3') RETURNING workspace_id`)).rows[0].workspace_id;
      await pool.query(`INSERT INTO custom_field_definitions (workspace_id, name, key, type) VALUES ($1,'Score','score','number')`, [localWs]);
      const c1 = (await pool.query(`INSERT INTO contacts (workspace_id, email, status) VALUES ($1,'s1@x.com','active') RETURNING contact_id`, [localWs])).rows[0].contact_id;

      await applyBulkAction(pool, localWs, { contactIds: [c1] }, { type: 'set_custom_field', key: 'score', value: '42' }, 'u');
      const cf = (await pool.query(`SELECT custom_fields FROM contacts WHERE contact_id = $1`, [c1])).rows[0].custom_fields;
      expect(cf.score).toBe(42);

      await expect(
        applyBulkAction(pool, localWs, { contactIds: [c1] }, { type: 'set_custom_field', key: 'score', value: 'not-a-number' }, 'u'),
      ).rejects.toThrow();
    });
  });
});
