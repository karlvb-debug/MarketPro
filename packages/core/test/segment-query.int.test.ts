// Dynamic segment membership against real Postgres: the static and dynamic
// resolvers, dispatch page fetch, launch estimate, and count preview must
// all agree on exactly who is in a segment. Skipped unless TEST_DATABASE_URL.

import { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import {
  loadSegment,
  countSegmentMembers,
  countRulePreview,
  RuleValidationError,
} from '../src/segment-query';
import { countEligibleRecipients } from '../src/campaign-launch';
import { createDispatchStore } from '../src/dispatch/store';
import { closePool } from '../src/db';
import { RuleGroup } from '../src/rules';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('dynamic segments (Postgres integration)', () => {
  let pool: Pool;
  let workspaceId: string;
  let staticSegId: string;
  let dynamicSegId: string;
  const contactIds: Record<string, string> = {};

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await runMigrations(pool);
    process.env.DATABASE_URL = TEST_DATABASE_URL;

    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('seg') RETURNING workspace_id`);
    workspaceId = ws.rows[0].workspace_id;

    // pro+active, free+active, pro+unsubscribed, pro+active(no phone)
    const fixtures = [
      { key: 'a', email: 'a@x.com', phone: '+15550000001', status: 'active', plan: 'pro' },
      { key: 'b', email: 'b@x.com', phone: '+15550000002', status: 'active', plan: 'free' },
      { key: 'c', email: 'c@x.com', phone: '+15550000003', status: 'unsubscribed', plan: 'pro' },
      { key: 'd', email: 'd@x.com', phone: null, status: 'active', plan: 'pro' },
    ];
    for (const f of fixtures) {
      const r = await pool.query(
        `INSERT INTO contacts (workspace_id, email, phone, status, custom_fields)
         VALUES ($1, $2, $3, $4::contact_status, $5) RETURNING contact_id`,
        [workspaceId, f.email, f.phone, f.status, JSON.stringify({ plan: f.plan })],
      );
      contactIds[f.key] = r.rows[0].contact_id;
    }

    await pool.query(
      `INSERT INTO custom_field_definitions (workspace_id, name, key, type, options)
       VALUES ($1, 'Plan', 'plan', 'select', $2)`,
      [workspaceId, JSON.stringify(['free', 'pro'])],
    );

    // Static segment: explicitly a and b
    const staticSeg = await pool.query(
      `INSERT INTO segments (workspace_id, name, kind) VALUES ($1, 'static', 'static') RETURNING segment_id`,
      [workspaceId],
    );
    staticSegId = staticSeg.rows[0].segment_id;
    await pool.query(`INSERT INTO contact_segment (contact_id, segment_id) VALUES ($1, $2), ($3, $2)`, [
      contactIds.a,
      staticSegId,
      contactIds.b,
    ]);

    // Dynamic segment: plan = pro
    const proRules: RuleGroup = { combinator: 'and', conditions: [{ field: 'custom.plan', op: 'eq', value: 'pro' }] };
    const dynSeg = await pool.query(
      `INSERT INTO segments (workspace_id, name, kind, rules) VALUES ($1, 'pros', 'dynamic', $2) RETURNING segment_id`,
      [workspaceId, JSON.stringify(proRules)],
    );
    dynamicSegId = dynSeg.rows[0].segment_id;
  });

  afterAll(async () => {
    await closePool(); // createDispatchStore uses the shared singleton pool
    await pool?.end();
  });

  test('loadSegment distinguishes kinds', async () => {
    expect((await loadSegment(pool, workspaceId, staticSegId))?.kind).toBe('static');
    expect((await loadSegment(pool, workspaceId, dynamicSegId))?.kind).toBe('dynamic');
    expect(await loadSegment(pool, workspaceId, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  test('static membership counts explicit rows', async () => {
    expect(await countSegmentMembers(pool, workspaceId, staticSegId)).toBe(2);
  });

  test('dynamic membership counts all rule matches (a, c, d are pro)', async () => {
    expect(await countSegmentMembers(pool, workspaceId, dynamicSegId)).toBe(3);
  });

  test('countEligibleRecipients applies active + channel reachability on top of membership', async () => {
    // dynamic pros, email: a, c, d are pro; c is unsubscribed → a, d
    expect(await countEligibleRecipients(pool, workspaceId, dynamicSegId, 'email')).toBe(2);
    // dynamic pros, sms (needs phone): a has phone, d has none, c unsubscribed → a
    expect(await countEligibleRecipients(pool, workspaceId, dynamicSegId, 'sms')).toBe(1);
    // static a, b email, both active → 2
    expect(await countEligibleRecipients(pool, workspaceId, staticSegId, 'email')).toBe(2);
  });

  test('dispatch fetchContactsPage returns the same active dynamic members', async () => {
    const store = await createDispatchStore();
    const page = await store.fetchContactsPage(workspaceId, dynamicSegId, null, 500);
    const emails = page.map((c) => c.email).sort();
    // active pros reachable for dispatch: a and d (c is unsubscribed)
    expect(emails).toEqual(['a@x.com', 'd@x.com']);
  });

  test('count preview matches a saved dynamic segment with the same rules', async () => {
    const rules = { combinator: 'and', conditions: [{ field: 'custom.plan', op: 'eq', value: 'pro' }] };
    expect(await countRulePreview(pool, workspaceId, rules)).toBe(3);
  });

  test('invalid preview rules throw RuleValidationError', async () => {
    await expect(
      countRulePreview(pool, workspaceId, { combinator: 'and', conditions: [{ field: 'evil', op: 'eq', value: 'x' }] }),
    ).rejects.toBeInstanceOf(RuleValidationError);
  });

  test('a dynamic segment with no rules matches nobody (fail closed)', async () => {
    const seg = await pool.query(
      `INSERT INTO segments (workspace_id, name, kind, rules) VALUES ($1, 'empty', 'dynamic', NULL) RETURNING segment_id`,
      [workspaceId],
    );
    expect(await countSegmentMembers(pool, workspaceId, seg.rows[0].segment_id)).toBe(0);
  });

  test('tenant isolation: another workspace cannot resolve the segment', async () => {
    const other = await pool.query(`INSERT INTO workspaces (name) VALUES ('other') RETURNING workspace_id`);
    expect(await loadSegment(pool, other.rows[0].workspace_id, dynamicSegId)).toBeNull();
    expect(await countSegmentMembers(pool, other.rows[0].workspace_id, dynamicSegId)).toBe(0);
  });
});
