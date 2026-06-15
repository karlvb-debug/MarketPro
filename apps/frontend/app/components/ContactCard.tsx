'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import type {
  Contact, Segment, SuppressionReason,
  TimelineEvent, TimelineResponse, ConsentStateResponse,
} from '../lib/store';
import { getOverallStatus } from '../lib/store';
import { api } from '../lib/api-client';
import { ComplianceBadges } from './StatusBadge';
import { Button, Input, Select, showToast, LoadingState } from './ui';
import { validatePhone } from '../lib/contact-utils';

// ============================================
// Types
// ============================================

type Tab = 'profile' | 'activity' | 'engagement' | 'consent' | 'segments' | 'compliance' | 'metadata';

interface ContactCardProps {
  contact: Contact;
  onClose: () => void;
  onUpdate: (contactId: string, patch: Partial<Contact>) => void;
  onDelete: (contactId: string) => void;
  onUpdateCompliance: (contactId: string, channel: 'email' | 'sms' | 'voice', reason: SuppressionReason, isDnc?: boolean) => void;
  segments?: Segment[];
  onAddToSegment?: (contactIds: string[], segmentName: string) => void;
  onRemoveFromSegment?: (contactIds: string[], segmentName: string) => void;
}

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'profile', label: 'Profile', icon: '⊡' },
  { key: 'activity', label: 'Activity', icon: '⋰' },
  { key: 'engagement', label: 'Stats', icon: '◴' },
  { key: 'consent', label: 'Consent', icon: '✓' },
  { key: 'segments', label: 'Segments', icon: '◫' },
  { key: 'compliance', label: 'Compliance', icon: '◉' },
  { key: 'metadata', label: 'Details', icon: '⋮' },
];

const CHANNEL_META: Record<string, { emoji: string; label: string }> = {
  email: { emoji: '@', label: 'Email' },
  sms:   { emoji: '#', label: 'SMS' },
  voice: { emoji: '☎', label: 'Voice' },
};

const SUPPRESS_OPTIONS: Record<string, SuppressionReason[]> = {
  email: ['unsubscribed', 'bounced', 'complained', 'invalid'],
  sms:   ['stop', 'unsubscribed', 'invalid'],
  voice: ['stop', 'unsubscribed', 'invalid'],
};

const REASON_LABELS: Record<string, string> = {
  none: 'Active',
  unsubscribed: 'Unsubscribed',
  stop: 'STOP',
  bounced: 'Bounced',
  complained: 'Complained',
  dnc: 'Do Not Contact',
  invalid: 'Invalid',
};

const CONSENT_LABELS: Record<string, string> = {
  collected_by_us: 'Collected directly',
  partner_with_proof: 'Third-party w/ proof',
  existing_customers: 'Existing customer (EBR)',
  purchased_list: 'Purchased list',
  unknown: 'Unknown',
};

// ============================================
// Date helpers
// ============================================

/** Relative time like "2 days ago" / "just now". Returns '' for nullish input. */
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? 'ago' : 'from now';
  const sec = Math.round(abs / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ${suffix}`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ${suffix}`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ${suffix}`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `${mon} month${mon === 1 ? '' : 's'} ${suffix}`;
  const yr = Math.round(mon / 12);
  return `${yr} year${yr === 1 ? '' : 's'} ${suffix}`;
}

/** Absolute timestamp for title/hover attributes. */
function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// ============================================
// Timeline event rendering
// ============================================

/** Map a timeline event to a dot tone + human-readable label. */
function describeEvent(ev: TimelineEvent): { tone: 'success' | 'info' | 'warning' | 'danger'; text: string } {
  switch (ev.type) {
    case 'message': {
      const channel = ev.channel || 'channel';
      const status = (ev.status || 'sent').toLowerCase();
      const verb =
        status === 'clicked' ? 'Clicked' :
        status === 'opened' ? 'Opened' :
        status === 'delivered' ? 'Delivered' :
        status === 'bounced' ? 'Bounced' :
        status === 'failed' ? 'Failed' :
        'Sent';
      const tone =
        status === 'clicked' || status === 'opened' ? 'success' :
        status === 'bounced' || status === 'failed' ? 'danger' :
        'info';
      const campaign = ev.campaignName ? ` · ${ev.campaignName}` : '';
      return { tone, text: `${verb} via ${channel}${campaign}` };
    }
    case 'consent': {
      const channel = ev.consentChannel || 'all channels';
      const source = ev.source ? ` (${ev.source})` : '';
      if (ev.consentType === 'opt_out') {
        return { tone: 'danger', text: `Opted out of ${channel}${source}` };
      }
      return { tone: 'success', text: `Opted in to ${channel}${source}` };
    }
    case 'inbound_sms':
    case 'inbound_email': {
      const via = ev.type === 'inbound_sms' ? 'SMS' : 'email';
      const body = ev.body ? `: ${ev.body}` : '';
      return { tone: 'warning', text: `Replied via ${via}${body}` };
    }
    default:
      return { tone: 'info', text: 'Activity' };
  }
}

// ============================================
// Component
// ============================================

export default function ContactCard({
  contact, onClose, onUpdate, onDelete, onUpdateCompliance,
  segments = [], onAddToSegment, onRemoveFromSegment,
}: ContactCardProps) {
  const [activeTab, setActiveTab] = useState<Tab>('profile');
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState({
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    company: contact.company,
    state: contact.state || '',
    timezone: contact.timezone || '',
  });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleEditCancel = () => {
    setIsEditing(false);
    setEditData({
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      company: contact.company,
      state: contact.state || '',
      timezone: contact.timezone || '',
    });
  };

  const handleSave = () => {
    if (editData.phone) {
      const result = validatePhone(editData.phone);
      if (!result.valid) {
        showToast(result.error, 'error');
        return;
      }
      editData.phone = result.normalized;
    }
    onUpdate(contact.contactId, editData);
    setIsEditing(false);
  };

  const overallStatus = getOverallStatus(contact.compliance);

  const statusColor =
    overallStatus === 'active' ? 'var(--accent-success)' :
    overallStatus === 'dnc' ? 'var(--accent-error)' :
    overallStatus === 'suppressed' ? 'var(--accent-error)' :
    'var(--accent-warning)';

  const statusLabel =
    overallStatus === 'active' ? 'Active' :
    overallStatus === 'dnc' ? 'Do Not Contact' :
    overallStatus === 'suppressed' ? 'All Suppressed' :
    'Partial';

  // Segments this contact is NOT in (for add dropdown)
  const availableSegments = useMemo(() =>
    segments.filter((seg) => !contact.segments.includes(seg.name)),
  [segments, contact.segments]);

  return (
    <div className="cc">
      {/* Header */}
      <div className="cc-header">
        <div className="cc-header-top">
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close contact details">✕</Button>
          <div className="cc-header-actions">
            {activeTab === 'profile' && (
              isEditing ? (
                <>
                  <Button variant="ghost" size="sm" onClick={handleEditCancel}>Cancel</Button>
                  <Button variant="primary" size="sm" onClick={handleSave}>Save</Button>
                </>
              ) : (
                <Button size="sm" onClick={() => setIsEditing(true)}>Edit</Button>
              )
            )}
          </div>
        </div>

        <div className="cc-avatar">
          {contact.firstName?.[0]?.toUpperCase() || ''}{contact.lastName?.[0]?.toUpperCase() || ''}
        </div>

        <h2 className="cc-name">
          {contact.firstName} {contact.lastName}
        </h2>

        <div className="cc-status-row">
          <span className="cc-status-dot" style={{ background: statusColor }} />
          <span className="cc-status-label">{statusLabel}</span>
          <ComplianceBadges compliance={contact.compliance} />
        </div>

        {/* Tab bar */}
        <div className="cc-tabs" role="tablist" aria-label="Contact details">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              id={`cc-tab-${tab.key}`}
              role="tab"
              aria-selected={activeTab === tab.key}
              aria-controls={`cc-panel-${tab.key}`}
              tabIndex={activeTab === tab.key ? 0 : -1}
              className={`cc-tab ${activeTab === tab.key ? 'cc-tab-active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                e.preventDefault();
                const idx = TABS.findIndex((t) => t.key === activeTab);
                const next = e.key === 'ArrowRight'
                  ? (idx + 1) % TABS.length
                  : (idx - 1 + TABS.length) % TABS.length;
                const nextTab = TABS[next];
                if (nextTab) {
                  setActiveTab(nextTab.key);
                  document.getElementById(`cc-tab-${nextTab.key}`)?.focus();
                }
              }}
            >
              <span className="cc-tab-icon" aria-hidden="true">{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="cc-body">
        {/* ---- Profile Tab ---- */}
        {activeTab === 'profile' && (
          <div role="tabpanel" id="cc-panel-profile" aria-labelledby="cc-tab-profile">
            <h3 className="cc-section-title">Contact Information</h3>

            <div className="cc-detail-row">
              <span className="cc-detail-icon">@</span>
              <span className="cc-detail-label">Email</span>
              {isEditing ? (
                <Input
                  type="email"
                  aria-label="Email"
                  value={editData.email}
                  onChange={(e) => setEditData({ ...editData, email: e.target.value })}
                />
              ) : (
                <span className="cc-detail-value font-mono">
                  {contact.email || <span className="text-tertiary">—</span>}
                </span>
              )}
            </div>

            <div className="cc-detail-row">
              <span className="cc-detail-icon">#</span>
              <span className="cc-detail-label">Phone</span>
              {isEditing ? (
                <Input
                  type="tel"
                  aria-label="Phone"
                  value={editData.phone}
                  onChange={(e) => setEditData({ ...editData, phone: e.target.value })}
                />
              ) : (
                <span className="cc-detail-value font-mono">
                  {contact.phone || <span className="text-tertiary">—</span>}
                </span>
              )}
            </div>

            <div className="cc-detail-row">
              <span className="cc-detail-icon">□</span>
              <span className="cc-detail-label">Company</span>
              {isEditing ? (
                <Input
                  aria-label="Company"
                  value={editData.company}
                  onChange={(e) => setEditData({ ...editData, company: e.target.value })}
                />
              ) : (
                <span className="cc-detail-value">
                  {contact.company || <span className="text-tertiary">—</span>}
                </span>
              )}
            </div>

            <div className="cc-detail-row">
              <span className="cc-detail-icon">📍</span>
              <span className="cc-detail-label">State</span>
              {isEditing ? (
                <Input
                  placeholder="e.g. CA, FL, TX"
                  aria-label="State"
                  value={editData.state}
                  onChange={(e) => setEditData({ ...editData, state: e.target.value.toUpperCase().slice(0, 2) })}
                  style={{ textTransform: 'uppercase', maxWidth: 80 }}
                />
              ) : (
                <span className="cc-detail-value">
                  {contact.state || <span className="text-tertiary">—</span>}
                </span>
              )}
            </div>

            <div className="cc-detail-row">
              <span className="cc-detail-icon">⏱</span>
              <span className="cc-detail-label">Timezone</span>
              {isEditing ? (
                <Input
                  placeholder="e.g. America/New_York"
                  aria-label="Timezone"
                  value={editData.timezone}
                  onChange={(e) => setEditData({ ...editData, timezone: e.target.value })}
                />
              ) : (
                <span className="cc-detail-value">
                  {contact.timezone || <span className="text-tertiary">—</span>}
                </span>
              )}
            </div>

            {/* Quick segment badges */}
            {contact.segments && contact.segments.length > 0 && (
              <>
                <h3 className="cc-section-title mt-5">Segments</h3>
                <div className="cc-segments">
                  {contact.segments.map((seg) => (
                    <span key={seg} className="badge badge-info">{seg}</span>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ---- Activity Tab ---- */}
        {activeTab === 'activity' && (
          <div role="tabpanel" id="cc-panel-activity" aria-labelledby="cc-tab-activity">
            <ActivityTab contactId={contact.contactId} />
          </div>
        )}

        {/* ---- Engagement Tab ---- */}
        {activeTab === 'engagement' && (
          <div role="tabpanel" id="cc-panel-engagement" aria-labelledby="cc-tab-engagement">
            <EngagementTab contact={contact} />
          </div>
        )}

        {/* ---- Consent Tab ---- */}
        {activeTab === 'consent' && (
          <div role="tabpanel" id="cc-panel-consent" aria-labelledby="cc-tab-consent">
            <ConsentTab contact={contact} />
          </div>
        )}

        {/* ---- Segments Tab ---- */}
        {activeTab === 'segments' && (
          <div role="tabpanel" id="cc-panel-segments" aria-labelledby="cc-tab-segments">
            <h3 className="cc-section-title">Segment Membership</h3>

            {contact.segments.length === 0 ? (
              <div className="cc-empty-state">
                <span className="cc-empty-icon">◫</span>
                <p className="text-secondary text-sm">Not in any segments yet</p>
              </div>
            ) : (
              <div className="cc-segment-list">
                {contact.segments.map((segName) => {
                  const seg = segments.find((s) => s.name === segName);
                  return (
                    <div key={segName} className="cc-segment-item">
                      <div className="cc-segment-info">
                        <span
                          className="cc-segment-color"
                          style={{ background: seg?.color || 'var(--accent-primary)' }}
                        />
                        <span className="cc-segment-name">{segName}</span>
                        {seg && (
                          <span className="cc-segment-count">{seg.count} contacts</span>
                        )}
                      </div>
                      {onRemoveFromSegment && (
                        <Button
                          variant="ghost"
                          size="sm"
                          style={{ fontSize: 'var(--text-xs)', padding: '2px 6px', color: 'var(--text-tertiary)' }}
                          onClick={() => onRemoveFromSegment([contact.contactId], segName)}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add to segment */}
            {onAddToSegment && availableSegments.length > 0 && (
              <div className="cc-segment-add">
                <Select
                  value=""
                  aria-label="Add to segment"
                  onChange={(e) => {
                    if (e.target.value) {
                      onAddToSegment([contact.contactId], e.target.value);
                    }
                  }}
                  style={{ fontSize: 'var(--text-sm)' }}
                >
                  <option value="">+ Add to segment…</option>
                  {availableSegments.map((seg) => (
                    <option key={seg.segmentId} value={seg.name}>
                      {seg.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>
        )}

        {/* ---- Compliance Tab ---- */}
        {activeTab === 'compliance' && (
          <div role="tabpanel" id="cc-panel-compliance" aria-labelledby="cc-tab-compliance">
            <h3 className="cc-section-title">Channel Compliance</h3>
            <div className="cc-compliance">
              {(['email', 'sms', 'voice'] as const).map((channel) => {
                const ch = contact.compliance[channel];
                const meta = CHANNEL_META[channel];
                if (!meta) return null;

                return (
                  <div key={channel} className={`cc-compliance-row ${ch.suppressed ? 'cc-compliance-suppressed' : ''}`}>
                    <span className="cc-compliance-icon">{meta.emoji}</span>
                    <span className="cc-compliance-channel">{meta.label}</span>

                    {ch.suppressed ? (
                      <div className="cc-compliance-status">
                        <span className="badge badge-danger">{REASON_LABELS[ch.reason] || ch.reason}</span>
                        {ch.updatedAt && (
                          <span className="cc-compliance-date">
                            {new Date(ch.updatedAt).toLocaleDateString('en-US', {
                              month: 'short', day: 'numeric', year: 'numeric',
                            })}
                          </span>
                        )}
                        <Button
                          variant="ghost" size="sm"
                          style={{ fontSize: 'var(--text-xs)', padding: '2px 6px' }}
                          onClick={() => onUpdateCompliance(contact.contactId, channel, 'none')}
                        >
                          Reactivate
                        </Button>
                      </div>
                    ) : (
                      <div className="cc-compliance-status">
                        <span className="badge badge-success">Active</span>
                        <Select
                          value=""
                          aria-label={`Suppress ${meta.label}`}
                          onChange={(e) => {
                            const reason = e.target.value as SuppressionReason;
                            if (reason) {
                              onUpdateCompliance(
                                contact.contactId,
                                channel,
                                reason,
                                reason === 'dnc',
                              );
                            }
                          }}
                          style={{ fontSize: 'var(--text-xs)', padding: '2px 6px', width: 'auto', minWidth: '100px' }}
                        >
                          <option value="">Suppress…</option>
                          {SUPPRESS_OPTIONS[channel]?.map((r) => (
                            <option key={r} value={r}>{REASON_LABELS[r]}</option>
                          ))}
                          <option value="dnc">DNC (Global)</option>
                        </Select>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Consent source */}
            <h3 className="cc-section-title mt-5">Consent Source</h3>
            <div className="cc-meta">
              <div className="cc-meta-row">
                <span className="text-tertiary">Type</span>
                <span className="text-secondary">
                  {CONSENT_LABELS[contact.consentSource || ''] || contact.consentSource || '—'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ---- Metadata Tab ---- */}
        {activeTab === 'metadata' && (
          <div role="tabpanel" id="cc-panel-metadata" aria-labelledby="cc-tab-metadata">
            <h3 className="cc-section-title">Source & Dates</h3>
            <div className="cc-meta">
              <div className="cc-meta-row">
                <span className="text-tertiary">Source</span>
                <span className="font-mono text-secondary">{contact.source || '—'}</span>
              </div>
              <div className="cc-meta-row">
                <span className="text-tertiary">Created</span>
                <span className="text-secondary">
                  {new Date(contact.createdAt).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
                  })}
                </span>
              </div>
              <div className="cc-meta-row">
                <span className="text-tertiary">Contact ID</span>
                <span className="font-mono text-tertiary text-xs">
                  {contact.contactId}
                </span>
              </div>
            </div>

            {/* Custom fields */}
            {contact.customFields && Object.keys(contact.customFields).length > 0 && (
              <>
                <h3 className="cc-section-title mt-5">Custom Fields</h3>
                <div className="cc-meta">
                  {Object.entries(contact.customFields).map(([key, value]) => (
                    <div className="cc-meta-row" key={key}>
                      <span className="text-tertiary">{key}</span>
                      <span className="text-secondary">{value || '—'}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Delete zone */}
            <div className="cc-danger mt-6">
              {showDeleteConfirm ? (
                <div className="cc-delete-confirm">
                  <p className="text-secondary text-sm mb-3">
                    Delete <strong>{contact.firstName} {contact.lastName}</strong>? This cannot be undone.
                  </p>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
                    <Button variant="danger" size="sm" onClick={() => onDelete(contact.contactId)}>Delete</Button>
                  </div>
                </div>
              ) : (
                <Button variant="ghost" size="sm" className="cc-delete-btn" onClick={() => setShowDeleteConfirm(true)}>
                  Delete Contact
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// Activity Tab — lazy-loads the paginated timeline
// ============================================

function ActivityTab({ contactId }: { contactId: string }) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  // Guard against a duplicate initial fetch (StrictMode double-invoke).
  const startedRef = useRef(false);

  const fetchPage = useCallback(async (nextCursor: string | null) => {
    const res = await api.contacts.timeline(contactId, {
      cursor: nextCursor || undefined,
      pageSize: 30,
    }) as TimelineResponse | null;
    return {
      events: res?.data ?? [],
      nextCursor: res?.meta?.nextCursor ?? null,
      hasMore: res?.meta?.hasMore ?? false,
    };
  }, [contactId]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const page = await fetchPage(null);
        if (cancelled) return;
        setEvents(page.events);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } catch {
        if (cancelled) return;
        setError(true);
        showToast('Could not load activity timeline.', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fetchPage]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      setEvents((prev) => [...prev, ...page.events]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      showToast('Could not load more activity.', 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) return <LoadingState label="Loading activity…" />;

  if (error && events.length === 0) {
    return (
      <div className="cc-empty-state">
        <span className="cc-empty-icon">⚠</span>
        <p className="text-secondary text-sm">Couldn&apos;t load activity.</p>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="cc-empty-state">
        <span className="cc-empty-icon">⋰</span>
        <p className="text-secondary text-sm">No activity yet</p>
      </div>
    );
  }

  return (
    <>
      <h3 className="cc-section-title">Activity</h3>
      <div className="cc-timeline">
        {events.map((ev, i) => {
          const { tone, text } = describeEvent(ev);
          return (
            <div className="cc-timeline-item" key={`${ev.at}-${ev.type}-${i}`}>
              <span className={`cc-timeline-dot cc-timeline-dot-${tone}`} aria-hidden="true" />
              <div className="cc-timeline-content">
                <span className="cc-timeline-text">{text}</span>
                <span className="cc-timeline-time" title={absoluteTime(ev.at)}>
                  {relativeTime(ev.at)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {hasMore && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--space-3)' }}>
          <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </>
  );
}

// ============================================
// Engagement Tab — stat grid from the contact's rollup fields
// ============================================

function EngagementTab({ contact }: { contact: Contact }) {
  if (!contact.totalSent) {
    return (
      <div className="cc-empty-state">
        <span className="cc-empty-icon">◴</span>
        <p className="text-secondary text-sm">No messages sent yet</p>
      </div>
    );
  }

  const rate = (n: number) => (contact.totalSent ? `${Math.round((n / contact.totalSent) * 100)}%` : '—');

  const stats: { label: string; value: number; hint?: string }[] = [
    { label: 'Sent', value: contact.totalSent },
    { label: 'Delivered', value: contact.totalDelivered, hint: rate(contact.totalDelivered) },
    { label: 'Opened', value: contact.totalOpened, hint: rate(contact.totalOpened) },
    { label: 'Clicked', value: contact.totalClicked, hint: rate(contact.totalClicked) },
  ];

  return (
    <>
      <h3 className="cc-section-title">Engagement</h3>
      <div className="cc-stat-grid">
        {stats.map((s) => (
          <div className="cc-stat" key={s.label}>
            <span className="cc-stat-value">{s.value.toLocaleString()}</span>
            <span className="cc-stat-label">{s.label}</span>
            {s.hint && <span className="cc-stat-hint">{s.hint}</span>}
          </div>
        ))}
      </div>

      <div className="cc-meta mt-5">
        <div className="cc-meta-row">
          <span className="text-tertiary">Last sent</span>
          <span className="text-secondary" title={absoluteTime(contact.lastSentAt)}>
            {relativeTime(contact.lastSentAt) || '—'}
          </span>
        </div>
        <div className="cc-meta-row">
          <span className="text-tertiary">Last engaged</span>
          <span className="text-secondary" title={absoluteTime(contact.lastEngagedAt)}>
            {relativeTime(contact.lastEngagedAt) || '—'}
          </span>
        </div>
      </div>
    </>
  );
}

// ============================================
// Consent Tab — lazy-loads real per-channel consent + evidence ledger
// ============================================

function ConsentTab({ contact }: { contact: Contact }) {
  const [state, setState] = useState<ConsentStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.contacts.consent(contact.contactId) as ConsentStateResponse | null;
        if (cancelled) return;
        setState(res);
      } catch {
        if (cancelled) return;
        setError(true);
        showToast('Could not load consent state.', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [contact.contactId]);

  if (loading) return <LoadingState label="Loading consent…" />;

  if (error || !state) {
    return (
      <div className="cc-empty-state">
        <span className="cc-empty-icon">⚠</span>
        <p className="text-secondary text-sm">Couldn&apos;t load consent state.</p>
      </div>
    );
  }

  const channels: { key: 'email' | 'phone'; label: string }[] = [
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
  ];

  return (
    <>
      <h3 className="cc-section-title">Consent Status</h3>
      <div className="cc-compliance">
        {channels.map(({ key, label }) => {
          const ch = state[key];
          return (
            <div key={key} className={`cc-compliance-row ${ch.suppressed ? 'cc-compliance-suppressed' : ''}`}>
              <span className="cc-compliance-icon">{key === 'email' ? '@' : '#'}</span>
              <span className="cc-compliance-channel">{label}</span>
              <div className="cc-compliance-status">
                {ch.suppressed ? (
                  <>
                    <span className="badge badge-danger">Suppressed</span>
                    {ch.reason && <span className="cc-compliance-date">{ch.reason}</span>}
                  </>
                ) : (
                  <span className="badge badge-success">Subscribed</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <h3 className="cc-section-title mt-5">Evidence Ledger</h3>
      <p className="text-tertiary text-xs mb-3">
        Immutable audit trail of consent events — retained for TCPA/TSR compliance.
      </p>
      {state.ledger.length === 0 ? (
        <div className="cc-empty-state">
          <span className="cc-empty-icon">✓</span>
          <p className="text-secondary text-sm">No recorded consent events</p>
        </div>
      ) : (
        <div className="cc-ledger">
          {state.ledger.map((entry, i) => (
            <div className="cc-ledger-item" key={`${entry.at}-${i}`}>
              <span
                className={`cc-ledger-mark ${entry.consentType === 'opt_out' ? 'cc-ledger-mark-out' : 'cc-ledger-mark-in'}`}
                aria-hidden="true"
              >
                {entry.consentType === 'opt_out' ? '✕' : '✓'}
              </span>
              <div className="cc-ledger-body">
                <span className="cc-ledger-headline">
                  {entry.consentType === 'opt_out' ? 'Opt-out' : 'Opt-in'}
                  {' · '}
                  <span className="cc-ledger-channel">{entry.channel}</span>
                </span>
                <span className="cc-ledger-meta">
                  {entry.source ? `Source: ${entry.source}` : 'Source: unknown'}
                  {' · '}
                  <span title={absoluteTime(entry.at)}>{absoluteTime(entry.at)}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
