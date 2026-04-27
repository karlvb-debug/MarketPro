'use client';

import type { ContactCompliance, ChannelStatus, OverallStatus } from '../lib/store';
import { getOverallStatus } from '../lib/store';

// ============================================
// Status Badge — color-coded status pills
// ============================================

const CAMPAIGN_STATUS: Record<string, { className: string; label: string }> = {
  completed:  { className: 'badge-success', label: 'Completed' },
  sending:    { className: 'badge-info',    label: 'Sending' },
  scheduled:  { className: 'badge-warning', label: 'Scheduled' },
  draft:      { className: 'badge-neutral', label: 'Draft' },
  paused:     { className: 'badge-warning', label: 'Paused' },
  cancelled:  { className: 'badge-danger',  label: 'Cancelled' },
};

const CONTACT_STATUS: Record<string, { className: string; label: string }> = {
  active:       { className: 'badge-success', label: 'Active' },
  unsubscribed: { className: 'badge-neutral', label: 'Unsubscribed' },
  bounced:      { className: 'badge-danger',  label: 'Bounced' },
  complained:   { className: 'badge-warning', label: 'Complained' },
};

interface StatusBadgeProps {
  status: string;
  type?: 'campaign' | 'contact';
}

export default function StatusBadge({ status, type = 'campaign' }: StatusBadgeProps) {
  const map = type === 'contact' ? CONTACT_STATUS : CAMPAIGN_STATUS;
  const config = map[status] || { className: 'badge-neutral', label: status };
  return (
    <span className={`badge ${config.className}`}>
      <span className="badge-dot" />
      {config.label}
    </span>
  );
}

// ============================================
// Compliance Summary Badge — overall status
// ============================================

const OVERALL_CONFIG: Record<OverallStatus, { className: string; label: string }> = {
  active:     { className: 'badge-success', label: 'Active' },
  partial:    { className: 'badge-warning', label: 'Partial' },
  suppressed: { className: 'badge-danger',  label: 'Suppressed' },
  dnc:        { className: 'badge-danger',  label: 'DNC' },
};

export function ComplianceSummary({ compliance }: { compliance: ContactCompliance }) {
  const overall = getOverallStatus(compliance);
  const config = OVERALL_CONFIG[overall];
  return (
    <span className={`badge ${config.className}`}>
      <span className="badge-dot" />
      {config.label}
    </span>
  );
}

// ============================================
// Compliance Badges — compact per-channel icons
// ============================================

const CHANNEL_EMOJI: Record<string, string> = {
  email: '@',
  sms: '#',
  voice: '☎',
};

const REASON_LABELS: Record<string, string> = {
  none: 'Active',
  unsubscribed: 'Unsubscribed',
  stop: 'STOP',
  bounced: 'Bounced',
  complained: 'Complained',
  dnc: 'DNC',
  invalid: 'Invalid',
};

function ChannelDot({ channel, status }: { channel: string; status: ChannelStatus }) {
  const emoji = CHANNEL_EMOJI[channel] || '○';
  const label = REASON_LABELS[status.reason] || status.reason;
  const colorClass = status.suppressed ? 'compliance-dot-suppressed' : 'compliance-dot-active';

  return (
    <span
      className={`compliance-dot ${colorClass}`}
      title={`${channel.toUpperCase()}: ${label}`}
    >
      {emoji}
    </span>
  );
}

export function ComplianceBadges({ compliance }: { compliance: ContactCompliance }) {
  return (
    <span className="compliance-badges">
      <ChannelDot channel="email" status={compliance.email} />
      <ChannelDot channel="sms" status={compliance.sms} />
      <ChannelDot channel="voice" status={compliance.voice} />
    </span>
  );
}

// ============================================
// Segment Badge — blue info pills
// ============================================

export function SegmentBadge({ name }: { name: string }) {
  return <span className="badge badge-info">{name}</span>;
}

// ============================================
// Channel Icon — emoji + label
// ============================================

const CHANNEL_ICONS: Record<string, string> = {
  email: '@',
  sms:   '#',
  voice: '☎',
};

export function ChannelIcon({ channel, showLabel = true }: { channel: string; showLabel?: boolean }) {
  return (
    <span className="channel-icon">
      {CHANNEL_ICONS[channel] || '○'}
      {showLabel && <span>{channel.toUpperCase()}</span>}
    </span>
  );
}

export { REASON_LABELS };
