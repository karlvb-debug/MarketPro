'use client';

// ============================================
// RuleBuilder — reusable nested and/or rule editor.
//
// Renders a RuleGroup as nested condition rows and sub-groups, with
// add-condition / add-group / remove controls. Each condition row is a
// field picker (core + non-archived custom fields) → type-aware operator
// dropdown → type-aware value input. Field/operator metadata is shared with
// the contacts filter chips via app/lib/rule-fields.ts. Guardrails mirror the
// backend (max depth 5, max 50 conditions): add buttons disable at the cap.
// ============================================

import { useMemo } from 'react';
import type { CustomField, RuleCondition, RuleGroup, RuleOp, Segment } from '../lib/store';
import { Input, Select } from './ui';
import {
  buildRuleFieldRegistry,
  defaultOpForType,
  FALLBACK_RULE_FIELD,
  findRuleField,
  MAX_CONDITIONS,
  MAX_DEPTH,
  MULTI_VALUE_OPS,
  OP_LABELS,
  OPS_BY_TYPE,
  VALUELESS_OPS,
  type RuleFieldDef,
} from '../lib/rule-fields';

interface RuleBuilderProps {
  value: RuleGroup;
  onChange: (next: RuleGroup) => void;
  customFields: CustomField[];
  segments: Segment[];
}

function isGroup(node: RuleCondition | RuleGroup): node is RuleGroup {
  return 'combinator' in node;
}

/** Count every condition (leaf) in a tree — used for the MAX_CONDITIONS cap. */
function countConditions(group: RuleGroup): number {
  return group.conditions.reduce(
    (sum, node) => sum + (isGroup(node) ? countConditions(node) : 1),
    0,
  );
}

/** A fresh default condition for the first field in the registry. */
function defaultCondition(registry: RuleFieldDef[]): RuleCondition {
  const def = registry[0] ?? FALLBACK_RULE_FIELD;
  return { field: def.field, op: defaultOpForType(def.type) };
}

export default function RuleBuilder({ value, onChange, customFields, segments }: RuleBuilderProps) {
  const registry = useMemo(() => buildRuleFieldRegistry(customFields), [customFields]);

  const totalConditions = countConditions(value);
  const atConditionCap = totalConditions >= MAX_CONDITIONS;

  return (
    <div className="rule-builder">
      <GroupEditor
        group={value}
        onChange={onChange}
        registry={registry}
        segments={segments}
        depth={1}
        atConditionCap={atConditionCap}
        onRemove={null}
      />
      <p className="form-hint rule-builder-meta">
        {totalConditions} / {MAX_CONDITIONS} condition{totalConditions === 1 ? '' : 's'} · max nesting {MAX_DEPTH} levels
      </p>
    </div>
  );
}

interface GroupEditorProps {
  group: RuleGroup;
  onChange: (next: RuleGroup) => void;
  registry: RuleFieldDef[];
  segments: Segment[];
  depth: number;
  atConditionCap: boolean;
  /** null = this is the root group (no remove control). */
  onRemove: (() => void) | null;
}

function GroupEditor({ group, onChange, registry, segments, depth, atConditionCap, onRemove }: GroupEditorProps) {
  const setCombinator = (combinator: 'and' | 'or') => onChange({ ...group, combinator });

  const updateChild = (index: number, next: RuleCondition | RuleGroup) => {
    onChange({ ...group, conditions: group.conditions.map((c, i) => (i === index ? next : c)) });
  };

  const removeChild = (index: number) => {
    onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== index) });
  };

  const addCondition = () => {
    onChange({ ...group, conditions: [...group.conditions, defaultCondition(registry)] });
  };

  const addGroup = () => {
    onChange({
      ...group,
      conditions: [...group.conditions, { combinator: 'and', conditions: [defaultCondition(registry)] }],
    });
  };

  const canNestDeeper = depth < MAX_DEPTH;

  return (
    <div className={`rb-group rb-group-depth-${depth}`}>
      <div className="rb-group-header">
        <div className="rb-combinator" role="group" aria-label="Match combinator">
          <button
            type="button"
            className={`rb-combinator-btn ${group.combinator === 'and' ? 'active' : ''}`}
            onClick={() => setCombinator('and')}
          >
            ALL
          </button>
          <button
            type="button"
            className={`rb-combinator-btn ${group.combinator === 'or' ? 'active' : ''}`}
            onClick={() => setCombinator('or')}
          >
            ANY
          </button>
          <span className="rb-combinator-label">
            of the following {group.combinator === 'and' ? '(AND)' : '(OR)'}
          </span>
        </div>
        {onRemove && (
          <button
            type="button"
            className="rb-remove-btn"
            onClick={onRemove}
            title="Remove group"
            aria-label="Remove group"
          >
            ✕
          </button>
        )}
      </div>

      <div className="rb-group-body">
        {group.conditions.map((node, i) =>
          isGroup(node) ? (
            <GroupEditor
              key={i}
              group={node}
              onChange={(next) => updateChild(i, next)}
              registry={registry}
              segments={segments}
              depth={depth + 1}
              atConditionCap={atConditionCap}
              onRemove={() => removeChild(i)}
            />
          ) : (
            <ConditionRow
              key={i}
              condition={node}
              onChange={(next) => updateChild(i, next)}
              onRemove={group.conditions.length > 1 || depth > 1 ? () => removeChild(i) : null}
              registry={registry}
              segments={segments}
            />
          ),
        )}
      </div>

      <div className="rb-group-actions">
        <button
          type="button"
          className="rb-add-btn"
          onClick={addCondition}
          disabled={atConditionCap}
          title={atConditionCap ? `Maximum of ${MAX_CONDITIONS} conditions reached` : 'Add a condition'}
        >
          + Condition
        </button>
        <button
          type="button"
          className="rb-add-btn"
          onClick={addGroup}
          disabled={atConditionCap || !canNestDeeper}
          title={
            !canNestDeeper
              ? `Maximum nesting depth of ${MAX_DEPTH} reached`
              : atConditionCap
                ? `Maximum of ${MAX_CONDITIONS} conditions reached`
                : 'Add a nested group'
          }
        >
          + Group
        </button>
        {(atConditionCap || !canNestDeeper) && (
          <span className="rb-cap-hint">
            {atConditionCap
              ? `Limit of ${MAX_CONDITIONS} conditions reached.`
              : `Limit of ${MAX_DEPTH} nesting levels reached.`}
          </span>
        )}
      </div>
    </div>
  );
}

interface ConditionRowProps {
  condition: RuleCondition;
  onChange: (next: RuleCondition) => void;
  onRemove: (() => void) | null;
  registry: RuleFieldDef[];
  segments: Segment[];
}

function ConditionRow({ condition, onChange, onRemove, registry, segments }: ConditionRowProps) {
  const def = findRuleField(condition.field, registry) || registry[0];
  // The registry always carries the core field set; this guards the empty
  // edge only so the rest of the row can treat def as defined.
  if (!def) return null;
  const ops = OPS_BY_TYPE[def.type];

  const onFieldChange = (field: string) => {
    const nextDef = findRuleField(field, registry);
    if (!nextDef) return;
    // Reset op + value to sane defaults for the new field type.
    const nextOp = defaultOpForType(nextDef.type);
    onChange(buildDefaultValue({ field, op: nextOp }, nextDef, segments));
  };

  const onOpChange = (op: RuleOp) => {
    onChange(buildDefaultValue({ ...condition, op }, def, segments));
  };

  return (
    <div className="rb-condition">
      <Select
        className="rb-field"
        aria-label="Field"
        value={condition.field}
        onChange={(e) => onFieldChange(e.target.value)}
      >
        {registry.map((f) => (
          <option key={f.field} value={f.field}>{f.label}</option>
        ))}
      </Select>

      <Select
        className="rb-op"
        aria-label="Operator"
        value={condition.op}
        onChange={(e) => onOpChange(e.target.value as RuleOp)}
      >
        {ops.map((op) => (
          <option key={op} value={op}>{OP_LABELS[op]}</option>
        ))}
      </Select>

      <ValueInput condition={condition} def={def} segments={segments} onChange={onChange} />

      {onRemove && (
        <button
          type="button"
          className="rb-remove-btn"
          onClick={onRemove}
          title="Remove condition"
          aria-label="Remove condition"
        >
          ✕
        </button>
      )}
    </div>
  );
}

/** Reset a condition's value to a sensible default for its op/field type. */
function buildDefaultValue(cond: RuleCondition, def: RuleFieldDef, segments: Segment[]): RuleCondition {
  if (VALUELESS_OPS.has(cond.op)) {
    return { field: cond.field, op: cond.op };
  }
  if (cond.op === 'between') {
    return { ...cond, value: ['', ''] };
  }
  if (MULTI_VALUE_OPS.has(cond.op)) {
    return { ...cond, value: Array.isArray(cond.value) ? cond.value : [] };
  }
  if (def.type === 'segment') {
    const first = segments[0]?.segmentId || '';
    return { ...cond, op: 'eq', value: typeof cond.value === 'string' ? cond.value : first };
  }
  if (def.type === 'select' || def.type === 'enum') {
    const first = def.options?.[0] || '';
    return { ...cond, value: typeof cond.value === 'string' ? cond.value : first };
  }
  return { ...cond, value: typeof cond.value === 'string' || typeof cond.value === 'number' ? cond.value : '' };
}

interface ValueInputProps {
  condition: RuleCondition;
  def: RuleFieldDef;
  segments: Segment[];
  onChange: (next: RuleCondition) => void;
}

function ValueInput({ condition, def, segments, onChange }: ValueInputProps) {
  const { op } = condition;

  if (VALUELESS_OPS.has(op)) return <span className="rb-novalue" aria-hidden="true">—</span>;

  // Segment membership picker.
  if (def.type === 'segment') {
    return (
      <Select
        className="rb-value"
        aria-label="Segment"
        value={typeof condition.value === 'string' ? condition.value : ''}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
      >
        <option value="">Select segment…</option>
        {segments.map((s) => (
          <option key={s.segmentId} value={s.segmentId}>{s.name}</option>
        ))}
      </Select>
    );
  }

  // between — two inputs.
  if (op === 'between') {
    const pair = Array.isArray(condition.value) ? condition.value : ['', ''];
    const inputType = def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text';
    return (
      <div className="rb-between">
        <Input
          className="rb-value"
          type={inputType}
          aria-label="Lower bound"
          value={String(pair[0] ?? '')}
          onChange={(e) => onChange({ ...condition, value: [e.target.value, pair[1] ?? ''] })}
        />
        <span className="rb-between-sep">and</span>
        <Input
          className="rb-value"
          type={inputType}
          aria-label="Upper bound"
          value={String(pair[1] ?? '')}
          onChange={(e) => onChange({ ...condition, value: [pair[0] ?? '', e.target.value] })}
        />
      </div>
    );
  }

  // in / not_in — multi-value. For enum/select, render a checklist; otherwise
  // a comma-separated text input.
  if (MULTI_VALUE_OPS.has(op)) {
    const arr = Array.isArray(condition.value) ? condition.value.map(String) : [];
    if ((def.type === 'enum' || def.type === 'select') && def.options) {
      const toggle = (opt: string) => {
        const next = arr.includes(opt) ? arr.filter((v) => v !== opt) : [...arr, opt];
        onChange({ ...condition, value: next });
      };
      return (
        <div className="rb-multi" role="group" aria-label="Values">
          {def.options.map((opt) => (
            <label key={opt} className={`rb-multi-chip ${arr.includes(opt) ? 'checked' : ''}`}>
              <input type="checkbox" checked={arr.includes(opt)} onChange={() => toggle(opt)} />
              {opt}
            </label>
          ))}
        </div>
      );
    }
    return (
      <Input
        className="rb-value"
        type="text"
        aria-label="Values (comma separated)"
        placeholder="value1, value2, …"
        value={arr.join(', ')}
        onChange={(e) =>
          onChange({
            ...condition,
            value: e.target.value.split(',').map((v) => v.trim()).filter((v) => v.length > 0),
          })
        }
      />
    );
  }

  // enum / select — single dropdown.
  if ((def.type === 'enum' || def.type === 'select') && def.options) {
    return (
      <Select
        className="rb-value"
        aria-label="Value"
        value={typeof condition.value === 'string' ? condition.value : ''}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
      >
        <option value="">Select…</option>
        {def.options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </Select>
    );
  }

  // number / date / within_days / text.
  const inputType =
    op === 'within_days' || def.type === 'number'
      ? 'number'
      : def.type === 'date'
        ? 'date'
        : 'text';
  return (
    <Input
      className="rb-value"
      type={inputType}
      aria-label="Value"
      placeholder={op === 'within_days' ? 'days' : 'Value…'}
      value={typeof condition.value === 'number' ? String(condition.value) : (condition.value as string) || ''}
      onChange={(e) =>
        onChange({
          ...condition,
          value: inputType === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value,
        })
      }
    />
  );
}
