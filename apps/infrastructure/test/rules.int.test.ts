// Rule engine semantics against real Postgres: the compiled SQL must
// select exactly the right contacts. Skipped unless TEST_DATABASE_URL set.

import { Pool } from 'pg';
import { runMigrations } from '../lambda/lib/migrate';
import { compileRules, RuleGroup, CustomFieldDefinition } from '../lambda/lib/rules';
import { findUniqueViolations, CustomFieldDef } from '../lambda/lib/custom-fields';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb('rule engine (Postgres integration)', () => {
  let pool: Pool;
  let workspaceId: string;
  let segmentId: string;
  const ids: Record<string, string> = {};

  const defs: CustomFieldDefinition[] = [
    { key: 'plan', type: 'select', options: ['free', 'pro'] },
    { key: 'score', type: 'number' },
  ];

  async function query(rules: RuleGroup): Promise<string[]> {
    const compiled = compileRules(rules, defs, 1);
    const result = await pool.query(
      `SELECT c.email FROM contacts c WHERE c.workspace_id = $1 AND ${compiled.text} ORDER BY c.email`,
      [workspaceId, ...compiled.params],
    );
    return result.rows.map((r) => r.email);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 3 });
    await runMigrations(pool);

    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('rules') RETURNING workspace_id`);
    workspaceId = ws.rows[0].workspace_id;
    const seg = await pool.query(
      `INSERT INTO segments (workspace_id, name) VALUES ($1, 'vips') RETURNING segment_id`,
      [workspaceId],
    );
    segmentId = seg.rows[0].segment_id;

    const fixtures = [
      { email: 'a@x.com', company: 'Acme', status: 'active', cf: { plan: 'pro', score: 90 }, days: 1, inSeg: true },
      { email: 'b@x.com', company: 'Beta', status: 'active', cf: { plan: 'free', score: 10 }, days: 45, inSeg: false },
      { email: 'c@x.com', company: null, status: 'unsubscribed', cf: {}, days: 5, inSeg: false },
    ];
    for (const f of fixtures) {
      const r = await pool.query(
        `INSERT INTO contacts (workspace_id, email, company, status, custom_fields, created_at)
         VALUES ($1, $2, $3, $4::contact_status, $5, NOW() - ($6::int * INTERVAL '1 day'))
         RETURNING contact_id`,
        [workspaceId, f.email, f.company, f.status, JSON.stringify(f.cf), f.days],
      );
      ids[f.email] = r.rows[0].contact_id;
      if (f.inSeg) {
        await pool.query(`INSERT INTO contact_segment (contact_id, segment_id) VALUES ($1, $2)`, [
          r.rows[0].contact_id,
          segmentId,
        ]);
      }
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  test('text, enum, and is_set semantics', async () => {
    expect(await query({ combinator: 'and', conditions: [{ field: 'company', op: 'contains', value: 'acm' }] })).toEqual(['a@x.com']);
    expect(await query({ combinator: 'and', conditions: [{ field: 'status', op: 'eq', value: 'unsubscribed' }] })).toEqual(['c@x.com']);
    expect(await query({ combinator: 'and', conditions: [{ field: 'company', op: 'not_set' }] })).toEqual(['c@x.com']);
  });

  test('custom select and numeric comparisons', async () => {
    expect(await query({ combinator: 'and', conditions: [{ field: 'custom.plan', op: 'eq', value: 'pro' }] })).toEqual(['a@x.com']);
    expect(await query({ combinator: 'and', conditions: [{ field: 'custom.score', op: 'gt', value: 50 }] })).toEqual(['a@x.com']);
    // missing custom value never matches numeric comparisons
    expect(await query({ combinator: 'and', conditions: [{ field: 'custom.score', op: 'lt', value: 50 }] })).toEqual(['b@x.com']);
  });

  test('relative dates and segment membership', async () => {
    expect(await query({ combinator: 'and', conditions: [{ field: 'created_at', op: 'within_days', value: 10 }] })).toEqual(['a@x.com', 'c@x.com']);
    expect(await query({ combinator: 'and', conditions: [{ field: 'in_segment', op: 'eq', value: segmentId }] })).toEqual(['a@x.com']);
    expect(await query({ combinator: 'and', conditions: [{ field: 'not_in_segment', op: 'eq', value: segmentId }] })).toEqual(['b@x.com', 'c@x.com']);
  });

  test('nested OR groups', async () => {
    const rows = await query({
      combinator: 'or',
      conditions: [
        { field: 'status', op: 'eq', value: 'unsubscribed' },
        { combinator: 'and', conditions: [{ field: 'custom.plan', op: 'eq', value: 'free' }, { field: 'custom.score', op: 'lte', value: 10 }] },
      ],
    });
    expect(rows).toEqual(['b@x.com', 'c@x.com']);
  });

  test('unique custom-field violation detection', async () => {
    const uniqueDefs: CustomFieldDef[] = [
      { fieldId: 'u1', key: 'plan', name: 'Plan', type: 'select', required: false, isUnique: true, options: ['free', 'pro'], archived: false },
    ];
    // 'pro' already taken by a@x.com
    expect(await findUniqueViolations(pool, workspaceId, uniqueDefs, { plan: 'pro' })).toEqual(['plan']);
    // ...but not when excluding that same contact (self-update)
    expect(await findUniqueViolations(pool, workspaceId, uniqueDefs, { plan: 'pro' }, ids['a@x.com'])).toEqual([]);
    expect(await findUniqueViolations(pool, workspaceId, uniqueDefs, { plan: 'free' }, ids['b@x.com'])).toEqual([]);
  });
});
