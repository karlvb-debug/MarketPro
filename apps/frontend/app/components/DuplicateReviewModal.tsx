'use client';

// ============================================
// Duplicate review — lists clusters of contacts colliding on a normalized
// email/phone (GET /contacts/duplicates), and merges a cluster into a chosen
// survivor (POST /contacts/merge, admin only).
//
// The duplicates endpoint returns only contactIds per cluster, so member
// details (name/email/phone) are fetched per id via GET /contacts/{id}.
// ============================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Modal, EmptyState, LoadingState, showToast } from './ui';
import { api, type DuplicateCluster } from '../lib/api-client';
import type { RawContactRow } from '../lib/store';

interface DuplicateReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Calls POST /contacts/merge and refreshes the store; resolves with mergedCount. */
  onMerge: (survivorId: string, duplicateIds: string[]) => Promise<{ survivorId: string; mergedCount: number }>;
}

interface MemberContact {
  contactId: string;
  name: string;
  email: string;
  phone: string;
}

function rowToMember(row: RawContactRow, id: string): MemberContact {
  const first = row.firstName || row.first_name || '';
  const last = row.lastName || row.last_name || '';
  const name = `${first} ${last}`.trim();
  return {
    contactId: row.contactId || row.contact_id || id,
    name: name || '(no name)',
    email: row.email || '',
    phone: row.phone || '',
  };
}

export default function DuplicateReviewModal({ isOpen, onClose, onMerge }: DuplicateReviewModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clusters, setClusters] = useState<DuplicateCluster[]>([]);
  const [members, setMembers] = useState<Record<string, MemberContact>>({});
  // The cluster currently open in the merge sub-modal (index into `clusters`).
  const [mergeIndex, setMergeIndex] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.contacts.duplicates({ limit: 200 });
      const list = res?.data || [];
      setClusters(list);

      // Fetch member details for every contact across all clusters (deduped).
      const ids = Array.from(new Set(list.flatMap((c) => c.contactIds)));
      const fetched = await Promise.all(
        ids.map(async (id) => {
          try {
            const row = (await api.contacts.get(id)) as RawContactRow;
            return [id, rowToMember(row, id)] as const;
          } catch {
            return [id, { contactId: id, name: '(unavailable)', email: '', phone: '' }] as const;
          }
        }),
      );
      setMembers(Object.fromEntries(fetched));
    } catch (err) {
      const message = (err as { message?: string } | null)?.message || 'Failed to load duplicates.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) load();
    else { setClusters([]); setMembers({}); setMergeIndex(null); setError(null); }
  }, [isOpen, load]);

  const activeCluster = mergeIndex !== null ? clusters[mergeIndex] : null;

  const handleMerged = async (survivorId: string, duplicateIds: string[]) => {
    await onMerge(survivorId, duplicateIds);
    // Drop the merged cluster from the local list and refresh the rest.
    setMergeIndex(null);
    await load();
  };

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title="Review Duplicate Contacts" size="lg">
        {loading ? (
          <LoadingState label="Finding duplicates…" />
        ) : error ? (
          <EmptyState icon="⚠" title="Couldn't load duplicates" description={error}>
            <Button size="sm" onClick={load}>Try again</Button>
          </EmptyState>
        ) : clusters.length === 0 ? (
          <EmptyState
            icon="✨"
            title="No duplicates found"
            description="No contacts share a normalized email or phone number."
          />
        ) : (
          <>
            <p className="text-secondary mb-4 text-sm">
              {clusters.length} duplicate cluster{clusters.length === 1 ? '' : 's'} found. Merging deletes the
              absorbed duplicates and keeps the survivor; empty survivor fields are filled from the duplicates.
            </p>
            <div className="dup-cluster-list">
              {clusters.map((cluster, i) => (
                <div key={`${cluster.keyType}:${cluster.key}`} className="dup-cluster">
                  <div className="dup-cluster-head">
                    <span className="badge badge-subtle">{cluster.keyType}</span>
                    <span className="dup-cluster-key">{cluster.key}</span>
                    <span className="text-tertiary text-xs">{cluster.contactIds.length} contacts</span>
                    <Button size="xs" variant="primary" onClick={() => setMergeIndex(i)} style={{ marginLeft: 'auto' }}>
                      Merge
                    </Button>
                  </div>
                  <ul className="dup-member-list">
                    {cluster.contactIds.map((id) => {
                      const m = members[id];
                      return (
                        <li key={id} className="dup-member">
                          <span className="dup-member-name">{m?.name || id}</span>
                          <span className="text-tertiary text-xs">{m?.email || '—'}</span>
                          <span className="text-tertiary text-xs">{m?.phone || '—'}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </>
        )}
      </Modal>

      {activeCluster && (
        <MergeClusterModal
          cluster={activeCluster}
          members={members}
          onClose={() => setMergeIndex(null)}
          onMerge={handleMerged}
        />
      )}
    </>
  );
}

// ---- Merge sub-modal: pick a survivor, confirm the absorb + delete ----

function MergeClusterModal({
  cluster,
  members,
  onClose,
  onMerge,
}: {
  cluster: DuplicateCluster;
  members: Record<string, MemberContact>;
  onClose: () => void;
  onMerge: (survivorId: string, duplicateIds: string[]) => Promise<void>;
}) {
  const [survivorId, setSurvivorId] = useState<string>(cluster.contactIds[0] || '');
  const [busy, setBusy] = useState(false);

  const duplicateIds = useMemo(
    () => cluster.contactIds.filter((id) => id !== survivorId),
    [cluster.contactIds, survivorId],
  );

  const submit = async () => {
    if (!survivorId) { showToast('Pick a survivor', 'error'); return; }
    if (duplicateIds.length === 0) { showToast('Select at least one duplicate to merge', 'error'); return; }
    setBusy(true);
    try {
      await onMerge(survivorId, duplicateIds);
    } catch {
      // onMerge already toasts; keep this modal open so the user can retry.
    } finally {
      setBusy(false);
    }
  };

  const radioGroup = `survivor-${cluster.keyType}-${cluster.key}`;

  return (
    <Modal isOpen onClose={onClose} title="Merge Duplicates" width="520px">
      <p className="text-secondary mb-4 text-sm">
        Pick the contact to <strong>keep</strong> (the survivor). The other{' '}
        {duplicateIds.length === 1 ? 'contact' : `${duplicateIds.length} contacts`} will be merged into it.
      </p>

      <fieldset className="dup-survivor-fieldset" style={{ border: 'none', padding: 0, margin: 0 }}>
        <legend className="text-sm" style={{ fontWeight: 500, marginBottom: 'var(--space-2)' }}>
          Survivor
        </legend>
        <div className="segment-pick-list">
          {cluster.contactIds.map((id) => {
            const m = members[id];
            const checked = survivorId === id;
            return (
              <label key={id} className={`radio-card ${checked ? 'checked' : ''}`}>
                <input
                  type="radio"
                  name={radioGroup}
                  checked={checked}
                  onChange={() => setSurvivorId(id)}
                />
                <div>
                  <div className="radio-card-label">{m?.name || id}</div>
                  <div className="radio-card-desc">
                    {(m?.email || '—')} · {(m?.phone || '—')}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="info-box info-box-warning mt-4 mb-4 text-xs" role="note">
        <strong>Heads up:</strong> the {duplicateIds.length === 1 ? 'duplicate' : 'duplicates'} will be permanently
        deleted. The survivor keeps its own non-empty fields; any blanks fall back to a duplicate&apos;s value.
        Segment memberships, history, and engagement are repointed to the survivor. This cannot be undone.
      </div>

      <div className="form-actions">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button type="button" variant="danger" disabled={busy || !survivorId || duplicateIds.length === 0} onClick={submit}>
          Merge {duplicateIds.length} into survivor
        </Button>
      </div>
    </Modal>
  );
}
