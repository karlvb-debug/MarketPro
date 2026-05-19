'use client';

import { useState, useMemo } from 'react';
import type { Contact, Segment, SuppressionReason } from '../lib/store';
import { getOverallStatus } from '../lib/store';
import { ComplianceBadges } from './StatusBadge';
import { Button, Input, Select, showToast } from './ui';
import { validatePhone } from '../lib/contact-utils';

// ============================================
// Types
// ============================================

type Tab = 'overview' | 'segments' | 'compliance' | 'metadata';

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
  { key: 'overview', label: 'Overview', icon: '⊡' },
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
// Component
// ============================================

export default function ContactCard({
  contact, onClose, onUpdate, onDelete, onUpdateCompliance,
  segments = [], onAddToSegment, onRemoveFromSegment,
}: ContactCardProps) {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
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
          <Button variant="ghost" size="sm" onClick={onClose}>✕</Button>
          <div className="cc-header-actions">
            {activeTab === 'overview' && (
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
        <div className="cc-tabs">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={`cc-tab ${activeTab === tab.key ? 'cc-tab-active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              <span className="cc-tab-icon">{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="cc-body">
        {/* ---- Overview Tab ---- */}
        {activeTab === 'overview' && (
          <>
            <h3 className="cc-section-title">Contact Information</h3>

            <div className="cc-detail-row">
              <span className="cc-detail-icon">@</span>
              <span className="cc-detail-label">Email</span>
              {isEditing ? (
                <Input
                  type="email"
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
          </>
        )}

        {/* ---- Segments Tab ---- */}
        {activeTab === 'segments' && (
          <>
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
          </>
        )}

        {/* ---- Compliance Tab ---- */}
        {activeTab === 'compliance' && (
          <>
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
                        <span className="badge badge-error">{REASON_LABELS[ch.reason] || ch.reason}</span>
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
          </>
        )}

        {/* ---- Metadata Tab ---- */}
        {activeTab === 'metadata' && (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
