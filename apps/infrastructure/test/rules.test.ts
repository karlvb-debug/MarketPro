import { compileRules, RuleGroup, RuleValidationError, CustomFieldDefinition } from '../lambda/lib/rules';
import { validateCustomFields, deriveKey, isValidKey, CustomFieldDef } from '../lambda/lib/custom-fields';

const noDefs: CustomFieldDefinition[] = [];

const g = (combinator: 'and' | 'or', ...conditions: RuleGroup['conditions']): RuleGroup => ({
  combinator,
  conditions,
});

describe('rule compiler', () => {
  test('compiles a simple condition with bound parameters', () => {
    const { text, params } = compileRules(g('and', { field: 'status', op: 'eq', value: 'active' }), noDefs);
    expect(text).toBe('(c.status::text = $1)');
    expect(params).toEqual(['active']);
  });

  test('respects paramOffset for queries with existing parameters', () => {
    const { text, params } = compileRules(
      g('and', { field: 'first_name', op: 'contains', value: 'ada' }),
      noDefs,
      3,
    );
    expect(text).toContain('$4');
    expect(params).toEqual(['ada']);
  });

  test('nested groups combine with AND/OR', () => {
    const { text } = compileRules(
      g(
        'and',
        { field: 'status', op: 'eq', value: 'active' },
        g('or', { field: 'company', op: 'is_set' }, { field: 'state', op: 'eq', value: 'CA' }),
      ),
      noDefs,
    );
    expect(text).toMatch(/AND \(\(c\.company IS NOT NULL.*OR c\.state = \$2\)/);
  });

  test('phone conditions normalize the bound value to digits', () => {
    const { params } = compileRules(g('and', { field: 'phone', op: 'eq', value: '(555) 123-4567' }), noDefs);
    expect(params).toEqual(['5551234567']);
  });

  test('within_days compiles to a relative date window', () => {
    const { text, params } = compileRules(
      g('and', { field: 'created_at', op: 'within_days', value: 30 }),
      noDefs,
    );
    expect(text).toContain("NOW() - ($1::int * INTERVAL '1 day')");
    expect(params).toEqual([30]);
  });

  test('custom fields compile through json accessors with type casts', () => {
    const defs: CustomFieldDefinition[] = [
      { key: 'plan', type: 'select', options: ['free', 'pro'] },
      { key: 'score', type: 'number' },
    ];
    const { text, params } = compileRules(
      g('and', { field: 'custom.plan', op: 'eq', value: 'pro' }, { field: 'custom.score', op: 'gt', value: 10 }),
      defs,
    );
    expect(text).toContain("c.custom_fields->>'plan'");
    expect(text).toContain('::numeric');
    expect(params).toEqual(['pro', 10]);
  });

  test('segment membership compiles to EXISTS', () => {
    const segId = '11111111-2222-4333-8444-555555555555';
    const { text } = compileRules(g('and', { field: 'not_in_segment', op: 'eq', value: segId }), noDefs);
    expect(text).toContain('NOT EXISTS (SELECT 1 FROM contact_segment');
  });
});

describe('rule compiler — hostile input', () => {
  const reject = (rules: unknown, defs: CustomFieldDefinition[] = noDefs) =>
    expect(() => compileRules(rules as RuleGroup, defs)).toThrow(RuleValidationError);

  test('unknown fields never compile', () => {
    reject(g('and', { field: 'password', op: 'eq', value: 'x' }));
    reject(g('and', { field: 'c.email; DROP TABLE contacts;--', op: 'eq', value: 'x' }));
    reject(g('and', { field: 'custom.undefined_key', op: 'eq', value: 'x' }));
  });

  test('SQL in values stays a bound parameter, never SQL text', () => {
    const { text, params } = compileRules(
      g('and', { field: 'email', op: 'eq', value: "x' OR '1'='1" }),
      noDefs,
    );
    expect(text).toBe('(c.email = $1)');
    expect(params).toEqual(["x' OR '1'='1"]);
  });

  test('invalid operators for a type are rejected', () => {
    reject(g('and', { field: 'status', op: 'contains', value: 'act' }));
    reject(g('and', { field: 'created_at', op: 'contains', value: 'x' }));
  });

  test('enum/select values outside the allowed set are rejected', () => {
    reject(g('and', { field: 'status', op: 'eq', value: 'superuser' }));
    reject(
      g('and', { field: 'custom.plan', op: 'eq', value: 'evil' }),
      [{ key: 'plan', type: 'select', options: ['free', 'pro'] }],
    );
  });

  test('depth and size bombs are rejected', () => {
    let bomb: RuleGroup = g('and', { field: 'email', op: 'is_set' });
    for (let i = 0; i < 6; i++) bomb = g('and', bomb);
    reject(bomb);

    const wide = g(
      'and',
      ...Array.from({ length: 51 }, () => ({ field: 'email' as const, op: 'is_set' as const })),
    );
    reject(wide);
  });

  test('segment ids must be UUIDs', () => {
    reject(g('and', { field: 'in_segment', op: 'eq', value: "x'); DROP TABLE contacts;--" }));
  });

  test('malformed structures are rejected', () => {
    reject({ combinator: 'xor', conditions: [{ field: 'email', op: 'is_set' }] });
    reject({ combinator: 'and', conditions: [] });
    reject(g('and', { field: 'email', op: 'between', value: 'not-an-array' as unknown as string }));
    reject(g('and', { field: 'status', op: 'in', value: [] }));
  });
});

describe('custom field validation (pure)', () => {
  const defs: CustomFieldDef[] = [
    { fieldId: '1', key: 'plan', name: 'Plan', type: 'select', required: true, isUnique: false, options: ['free', 'pro'], archived: false },
    { fieldId: '2', key: 'score', name: 'Score', type: 'number', required: false, isUnique: false, options: null, archived: false },
    { fieldId: '3', key: 'renewal', name: 'Renewal', type: 'date', required: false, isUnique: false, options: null, archived: false },
    { fieldId: '4', key: 'alt_email', name: 'Alt Email', type: 'email', required: false, isUnique: true, options: null, archived: false },
  ];

  test('coerces valid values per type', () => {
    const v = validateCustomFields(
      defs,
      { plan: 'pro', score: '42.5', renewal: '2026-12-01T10:00:00Z', alt_email: ' X@Y.CO ' },
      { forCreate: true },
    );
    expect(v.errors).toEqual({});
    expect(v.values).toEqual({ plan: 'pro', score: 42.5, renewal: '2026-12-01', alt_email: 'x@y.co' });
    expect(v.missingRequired).toEqual([]);
  });

  test('reports per-key errors and missing required on create', () => {
    const v = validateCustomFields(defs, { score: 'abc', alt_email: 'nope' }, { forCreate: true });
    expect(Object.keys(v.errors).sort()).toEqual(['alt_email', 'score']);
    expect(v.missingRequired).toEqual(['plan']);
  });

  test('updates do not enforce required; unknown keys pass through', () => {
    const v = validateCustomFields(defs, { freeform: 'hello' }, { forCreate: false });
    expect(v.missingRequired).toEqual([]);
    expect(v.values).toEqual({ freeform: 'hello' });
  });

  test('key derivation and validation', () => {
    expect(deriveKey('Plan Tier!')).toBe('plan_tier');
    expect(deriveKey('123 ABC')).toBe('f123_abc');
    expect(isValidKey('plan_tier')).toBe(true);
    expect(isValidKey('Plan')).toBe(false);
    expect(isValidKey("a'; --")).toBe(false);
  });
});
