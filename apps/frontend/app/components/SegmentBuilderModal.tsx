'use client';

// ============================================
// SegmentBuilderModal — create or edit a Smart (dynamic, rule-based) segment.
//
// Wraps RuleBuilder with name/description fields and a LIVE COUNT PREVIEW that
// debounces POST /segments/preview-count (~400ms) as the rules change. Used
// both from the segment panel ("New Smart Segment") and the contacts page
// ("Save current filter as a Smart Segment"), where it is pre-loaded with the
// active filters' RuleGroup.
// ============================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, type RuleGroup, type Segment } from '../lib/store';
import { api, type ApiError } from '../lib/api-client';
import { Button, Field, Input, Modal, FormActions, showToast } from './ui';
import RuleBuilder from './RuleBuilder';

interface SegmentBuilderModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** When set, edit this existing dynamic segment; otherwise create a new one. */
  editingSegment?: Segment | null;
  /** Pre-load the builder with these rules (e.g. from the contacts filters). */
  initialRules?: RuleGroup | null;
  /** Pre-fill the name (e.g. when saving a filter as a segment). */
  initialName?: string;
  /** Called with the created/updated segment id after a successful save. */
  onSaved?: (segmentId: string) => void;
}

const EMPTY_RULES: RuleGroup = { combinator: 'and', conditions: [] };

const PREVIEW_DEBOUNCE_MS = 400;

export default function SegmentBuilderModal({
  isOpen,
  onClose,
  editingSegment = null,
  initialRules = null,
  initialName = '',
  onSaved,
}: SegmentBuilderModalProps) {
  const { settings, segments, createSegment, updateSegment } = useStore();
  const isEditing = !!editingSegment;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rules, setRules] = useState<RuleGroup>(EMPTY_RULES);
  const [saving, setSaving] = useState(false);

  // Live preview state.
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Reset form whenever the modal opens or the target changes.
  useEffect(() => {
    if (!isOpen) return;
    if (editingSegment) {
      setName(editingSegment.name);
      setDescription(editingSegment.description || '');
      setRules(editingSegment.rules || EMPTY_RULES);
    } else {
      setName(initialName);
      setDescription('');
      setRules(initialRules || EMPTY_RULES);
    }
    setPreviewCount(null);
    setPreviewError(null);
  }, [isOpen, editingSegment, initialRules, initialName]);

  // Debounced live count. A monotonically-increasing request id discards
  // responses that arrive out of order, so the count always reflects the
  // latest rules.
  const reqIdRef = useRef(0);
  useEffect(() => {
    if (!isOpen) return;
    if (rules.conditions.length === 0) {
      setPreviewCount(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    const myReqId = ++reqIdRef.current;
    setPreviewLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api.segments.previewCount(rules);
        if (myReqId !== reqIdRef.current) return; // a newer request superseded this one
        setPreviewCount(res.total);
        setPreviewError(null);
      } catch (err) {
        if (myReqId !== reqIdRef.current) return;
        setPreviewCount(null);
        setPreviewError((err as Partial<ApiError> | null)?.message || 'Could not preview count');
      } finally {
        if (myReqId === reqIdRef.current) setPreviewLoading(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [rules, isOpen]);

  const handleSave = useCallback(async () => {
    if (!name.trim()) { showToast('Give the segment a name', 'error'); return; }
    if (rules.conditions.length === 0) { showToast('Add at least one rule', 'error'); return; }
    setSaving(true);
    let savedId: string | null = null;
    if (isEditing && editingSegment) {
      const error = await updateSegment(editingSegment.segmentId, {
        name: name.trim(),
        description: description.trim(),
        rules,
      });
      setSaving(false);
      if (error) return; // toast already shown by the store
      savedId = editingSegment.segmentId;
    } else {
      savedId = await createSegment({
        name: name.trim(),
        description: description.trim(),
        kind: 'dynamic',
        rules,
      });
      setSaving(false);
      if (!savedId) return; // toast already shown by the store
    }
    showToast(isEditing ? `Smart segment "${name.trim()}" updated` : `Smart segment "${name.trim()}" created`);
    if (savedId && onSaved) onSaved(savedId);
    onClose();
  }, [name, description, rules, isEditing, editingSegment, updateSegment, createSegment, onSaved, onClose]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? 'Edit Smart Segment' : 'New Smart Segment'}
      size="lg"
    >
      <Field label="Name" required>
        <Input
          placeholder="e.g. Active customers in CA"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </Field>
      <Field label="Description">
        <Input
          placeholder="Optional"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      <div className="form-field">
        <span className="form-label">Rules</span>
        <RuleBuilder
          value={rules}
          onChange={setRules}
          customFields={settings.customFields || []}
          segments={segments}
        />
      </div>

      {/* Live count preview */}
      <div className="segment-preview-count" aria-live="polite">
        {rules.conditions.length === 0 ? (
          <span className="text-tertiary text-sm">Add a rule to preview matching contacts.</span>
        ) : previewError ? (
          <span className="text-sm" style={{ color: 'var(--danger, #d33)' }}>⚠ {previewError}</span>
        ) : previewLoading && previewCount === null ? (
          <span className="text-secondary text-sm">Counting matching contacts…</span>
        ) : previewCount !== null ? (
          <span className="text-sm">
            <strong>{previewCount.toLocaleString()}</strong> contact{previewCount === 1 ? '' : 's'} match
            {previewLoading && <span className="text-tertiary"> · updating…</span>}
          </span>
        ) : (
          <span className="text-secondary text-sm">Counting…</span>
        )}
      </div>

      <FormActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={saving || !name.trim() || rules.conditions.length === 0}
        >
          {saving ? 'Saving…' : isEditing ? 'Save Changes' : 'Create Smart Segment'}
        </Button>
      </FormActions>
    </Modal>
  );
}
