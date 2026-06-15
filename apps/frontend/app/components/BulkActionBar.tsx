'use client';

// ============================================
// Bulk action bar — selection-aware bulk operations for the contacts page.
//
// Selection scope: when filters are active and every row on the page is
// checked, the user can choose to apply the action to *all N matching*
// contacts (sends { rules } built from the active filters) instead of just the
// checked ids (sends { contactIds }). meta.total provides N.
//
// Actions: add/remove segment, set custom field, unsubscribe, delete.
// Destructive actions (unsubscribe, delete) route through ConfirmDialog.
// Role gating: 'delete' is admin-only on the backend; the frontend has no
// role in its auth context, so we let the API 403 surface as a toast.
// ============================================

import { useMemo, useState } from 'react';
import { Button, Modal, Field, Input, Select, FormActions, showToast } from './ui';
import { useConfirm } from './ConfirmDialog';
import type { BulkAction, BulkSelection } from '../lib/api-client';
import type { CustomField, RuleGroup, Segment } from '../lib/store';

interface BulkActionBarProps {
  selectedIds: Set<string>;
  /** Total contacts matching the current filters/search (meta.total). */
  matchingTotal: number;
  /** True when at least one filter chip is active and compiles to rules. */
  filtersActive: boolean;
  /** Rules compiled from the active filter chips (null when none usable). */
  filterRules: RuleGroup | null;
  /** True when every row on the loaded page is checked. */
  allOnPageSelected: boolean;
  segments: Segment[];
  customFields: CustomField[];
  /** Calls POST /contacts/bulk and refreshes; resolves with the affected count. */
  onBulkAction: (selection: BulkSelection, action: BulkAction) => Promise<{ affected: number }>;
  /** Clears the row selection after a successful action. */
  onClearSelection: () => void;
}

type Scope = 'selected' | 'matching';

export default function BulkActionBar({
  selectedIds,
  matchingTotal,
  filtersActive,
  filterRules,
  allOnPageSelected,
  segments,
  customFields,
  onBulkAction,
  onClearSelection,
}: BulkActionBarProps) {
  const confirm = useConfirm();
  const [scope, setScope] = useState<Scope>('selected');
  const [busy, setBusy] = useState(false);
  const [segmentModal, setSegmentModal] = useState<null | 'add' | 'remove'>(null);
  const [showCustomFieldModal, setShowCustomFieldModal] = useState(false);

  const selectedCount = selectedIds.size;
  const usableFields = useMemo(
    () => customFields.filter((cf) => !cf.archived),
    [customFields],
  );

  // The "apply to all matching" scope is only offered when filters are active,
  // they compile to a usable rule tree, and every loaded row is checked
  // (so the user has signalled intent to act on the whole filtered set).
  const canScopeToMatching = filtersActive && !!filterRules && allOnPageSelected && matchingTotal > selectedCount;

  // Resolve the effective scope: fall back to 'selected' whenever the
  // matching-scope offer isn't available.
  const effectiveScope: Scope = canScopeToMatching && scope === 'matching' ? 'matching' : 'selected';
  const effectiveCount = effectiveScope === 'matching' ? matchingTotal : selectedCount;

  const buildSelection = (): BulkSelection => {
    if (effectiveScope === 'matching' && filterRules) {
      return { rules: filterRules };
    }
    return { contactIds: Array.from(selectedIds) };
  };

  const run = async (action: BulkAction) => {
    if (busy) return;
    setBusy(true);
    try {
      await onBulkAction(buildSelection(), action);
      onClearSelection();
      setSegmentModal(null);
      setShowCustomFieldModal(false);
    } catch {
      // onBulkAction already toasts the error; keep the bar/modal open.
    } finally {
      setBusy(false);
    }
  };

  const noun = `contact${effectiveCount === 1 ? '' : 's'}`;

  const handleUnsubscribe = async () => {
    const ok = await confirm(
      `Unsubscribe ${effectiveCount.toLocaleString()} ${noun}? They will be suppressed across email and SMS and added to the suppression list.`,
      { title: 'Unsubscribe Contacts', variant: 'danger', confirmLabel: `Unsubscribe ${effectiveCount.toLocaleString()}` },
    );
    if (ok) await run({ type: 'unsubscribe' });
  };

  const handleDelete = async () => {
    const ok = await confirm(
      `Permanently delete ${effectiveCount.toLocaleString()} ${noun}? This cannot be undone.`,
      { title: 'Delete Contacts', variant: 'danger', confirmLabel: `Delete ${effectiveCount.toLocaleString()}` },
    );
    if (ok) await run({ type: 'delete' });
  };

  return (
    <>
      <div className="bulk-action-bar" role="region" aria-label="Bulk actions">
        <span className="text-sm text-secondary">
          {selectedCount.toLocaleString()} selected
        </span>

        {canScopeToMatching && (
          <div className="bulk-scope" role="group" aria-label="Apply bulk action to">
            <Button
              size="xs"
              variant={effectiveScope === 'selected' ? 'primary' : 'secondary'}
              aria-pressed={effectiveScope === 'selected'}
              onClick={() => setScope('selected')}
            >
              {selectedCount.toLocaleString()} selected
            </Button>
            <Button
              size="xs"
              variant={effectiveScope === 'matching' ? 'primary' : 'secondary'}
              aria-pressed={effectiveScope === 'matching'}
              onClick={() => setScope('matching')}
            >
              All {matchingTotal.toLocaleString()} matching
            </Button>
          </div>
        )}

        <span className="bulk-action-divider" aria-hidden="true" />

        <Button size="xs" disabled={busy} onClick={() => setSegmentModal('add')}>
          Add to Segment
        </Button>
        <Button size="xs" disabled={busy} onClick={() => setSegmentModal('remove')}>
          Remove from Segment
        </Button>
        <Button size="xs" disabled={busy || usableFields.length === 0} onClick={() => setShowCustomFieldModal(true)}>
          Set Custom Field
        </Button>
        <Button size="xs" variant="danger" disabled={busy} onClick={handleUnsubscribe}>
          Unsubscribe
        </Button>
        <Button size="xs" variant="danger" disabled={busy} onClick={handleDelete}>
          Delete
        </Button>
      </div>

      {/* ===== ADD / REMOVE SEGMENT ===== */}
      <Modal
        isOpen={segmentModal !== null}
        onClose={() => setSegmentModal(null)}
        title={segmentModal === 'remove' ? 'Remove from Segment' : 'Add to Segment'}
        width="400px"
      >
        <p className="text-secondary mb-5 text-sm">
          {segmentModal === 'remove'
            ? `Choose a segment to remove ${effectiveCount.toLocaleString()} ${noun} from:`
            : `Choose a static segment to add ${effectiveCount.toLocaleString()} ${noun} to:`}
        </p>
        <div className="segment-pick-list">
          {segments
            .filter((seg) => seg.kind !== 'dynamic')
            .map((seg) => (
              <button
                key={seg.segmentId}
                className="segment-pick-item"
                disabled={busy}
                onClick={() => run(
                  segmentModal === 'remove'
                    ? { type: 'remove_segment', segmentId: seg.segmentId }
                    : { type: 'add_segment', segmentId: seg.segmentId },
                )}
              >
                <span>{seg.name}</span>
                <span className="text-tertiary text-xs">{seg.count} contacts</span>
              </button>
            ))}
          {segments.filter((seg) => seg.kind !== 'dynamic').length === 0 && (
            <p className="text-tertiary text-sm text-center p-6">
              No static segments yet. Dynamic (Smart) segments are rule-based and can&apos;t be edited here.
            </p>
          )}
        </div>
      </Modal>

      {/* ===== SET CUSTOM FIELD ===== */}
      {showCustomFieldModal && (
        <SetCustomFieldModal
          fields={usableFields}
          count={effectiveCount}
          busy={busy}
          onClose={() => setShowCustomFieldModal(false)}
          onApply={(key, value) => run({ type: 'set_custom_field', key, value })}
        />
      )}
    </>
  );
}

// ---- Set-custom-field sub-modal ----

function SetCustomFieldModal({
  fields,
  count,
  busy,
  onClose,
  onApply,
}: {
  fields: CustomField[];
  count: number;
  busy: boolean;
  onClose: () => void;
  onApply: (key: string, value: unknown) => void;
}) {
  const [key, setKey] = useState(fields[0]?.key || '');
  const [value, setValue] = useState('');
  const def = fields.find((f) => f.key === key);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!key) { showToast('Pick a field', 'error'); return; }
    // Coerce to the field's storage type; the backend re-validates.
    let coerced: unknown = value;
    if (def?.type === 'number') {
      const n = Number(value);
      if (value.trim() === '' || !Number.isFinite(n)) { showToast('Enter a valid number', 'error'); return; }
      coerced = n;
    }
    onApply(key, coerced);
  };

  return (
    <Modal isOpen onClose={onClose} title="Set Custom Field" width="420px">
      <p className="text-secondary mb-5 text-sm">
        Set one custom field value for {count.toLocaleString()} contact{count === 1 ? '' : 's'}.
      </p>
      <form onSubmit={submit}>
        <Field label="Field">
          <Select value={key} onChange={(e) => { setKey(e.target.value); setValue(''); }}>
            {fields.map((f) => (
              <option key={f.fieldId} value={f.key}>{f.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Value">
          {def?.type === 'select' && def.options ? (
            <Select value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">Select…</option>
              {def.options.map((opt) => (<option key={opt} value={opt}>{opt}</option>))}
            </Select>
          ) : (
            <Input
              type={def?.type === 'number' ? 'number' : def?.type === 'date' ? 'date' : 'text'}
              placeholder="New value for all selected…"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Field>
        <FormActions>
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Update {count.toLocaleString()} contact{count === 1 ? '' : 's'}
          </Button>
        </FormActions>
      </form>
    </Modal>
  );
}
