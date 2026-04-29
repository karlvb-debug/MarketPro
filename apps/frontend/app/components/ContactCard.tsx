'use client';

import { useState } from 'react';
import type { Contact, SuppressionReason, ContactCompliance, ChannelStatus } from '../lib/store';
import { getOverallStatus } from '../lib/store';
import { ComplianceBadges } from './StatusBadge';
import { FormInput, FormSelect } from './FormElements';
import { showToast } from './Toast';
import { validatePhone } from '../lib/contact-utils';

interface ContactCardProps {
  contact: Contact;
  onClose: () => void;
  onUpdate: (contactId: string, patch: Partial<Contact>) => void;
  onDelete: (contactId: string) => void;
  onUpdateCompliance: (contactId: string, channel: 'email' | 'sms' | 'voice', reason: SuppressionReason, isDnc?: boolean) => void;
}

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

export default function ContactCard({
  contact, onClose, onUpdate, onDelete, onUpdateCompliance,
}: ContactCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState({
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    company: contact.company,
    state: contact.state || '',
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
    });
  };

  const handleSave = () => {
    // Validate phone if provided
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

  return (
    <div className="cc">
      {/* Header */}
      <div className="cc-header">
        <div className="cc-header-top">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
          <div className="cc-header-actions">
            {isEditing ? (
              <>
                <button className="btn btn-ghost btn-sm" onClick={handleEditCancel}>Cancel</button>
                <button className="btn btn-primary btn-sm" onClick={handleSave}>Save</button>
              </>
            ) : (
              <button className="btn btn-secondary btn-sm" onClick={() => setIsEditing(true)}>Edit</button>
            )}
          </div>
        </div>

        <div className="cc-avatar">
          {contact.firstName?.[0]?.toUpperCase() || ''}{contact.lastName?.[0]?.toUpperCase() || ''}
        </div>

        {isEditing ? (
          <div className="cc-name-edit">
            <FormInput
              placeholder="First name"
              value={editData.firstName}
              onChange={(e) => setEditData({ ...editData, firstName: e.target.value })}
            />
            <FormInput
              placeholder="Last name"
              value={editData.lastName}
              onChange={(e) => setEditData({ ...editData, lastName: e.target.value })}
            />
          </div>
        ) : (
          <h2 className="cc-name">
            {contact.firstName} {contact.lastName}
          </h2>
        )}

        <div className="cc-status-row">
          <span className="cc-status-dot" style={{ background: statusColor }} />
          <span className="cc-status-label">{statusLabel}</span>
          <ComplianceBadges compliance={contact.compliance} />
        </div>
      </div>

      <div className="cc-body">
        <h3 className="cc-section-title">Contact Details</h3>

        <div className="cc-detail-row">
          <span className="cc-detail-icon">@</span>
          <span className="cc-detail-label">Email</span>
          {isEditing ? (
            <FormInput
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
            <FormInput
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
            <FormInput
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
            <FormInput
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

        {contact.segments && contact.segments.length > 0 && (
          <>
            <h3 className="cc-section-title" style={{ marginTop: 'var(--space-5)' }}>Segments</h3>
            <div className="cc-segments">
              {contact.segments.map((seg) => (
                <span key={seg} className="badge badge-info">{seg}</span>
              ))}
            </div>
          </>
        )}

        <h3 className="cc-section-title" style={{ marginTop: 'var(--space-5)' }}>Channel Compliance</h3>
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
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ fontSize: 'var(--text-xs)', padding: '2px 6px' }}
                      onClick={() => onUpdateCompliance(contact.contactId, channel, 'none')}
                    >
                      Reactivate
                    </button>
                  </div>
                ) : (
                  <div className="cc-compliance-status">
                    <span className="badge badge-success">Active</span>
                    <FormSelect
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
                    </FormSelect>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <h3 className="cc-section-title" style={{ marginTop: 'var(--space-5)' }}>Metadata</h3>
        <div className="cc-meta">
          <div className="cc-meta-row">
            <span className="text-tertiary">Source</span>
            <span className="font-mono text-secondary">{contact.source || '—'}</span>
          </div>
          <div className="cc-meta-row">
            <span className="text-tertiary">Created</span>
            <span className="text-secondary">
              {new Date(contact.createdAt).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
              })}
            </span>
          </div>
          <div className="cc-meta-row">
            <span className="text-tertiary">ID</span>
            <span className="font-mono text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>
              {contact.contactId}
            </span>
          </div>
        </div>

        <div className="cc-danger" style={{ marginTop: 'var(--space-6)' }}>
          {showDeleteConfirm ? (
            <div className="cc-delete-confirm">
              <p className="text-secondary" style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-3)' }}>
                Delete <strong>{contact.firstName} {contact.lastName}</strong>? This cannot be undone.
              </p>
              <div className="flex gap-2">
                <button className="btn btn-ghost btn-sm" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
                <button className="btn btn-danger btn-sm" onClick={() => onDelete(contact.contactId)}>Delete</button>
              </div>
            </div>
          ) : (
            <button className="btn btn-ghost btn-sm cc-delete-btn" onClick={() => setShowDeleteConfirm(true)}>
              Delete Contact
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
