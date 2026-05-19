'use client';

import { ReactNode } from 'react';

// ============================================
// Badge — status/info pills
// Replaces StatusBadge and ad-hoc badge markup
// ============================================

export type BadgeTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  /** Render as small dot + text */
  dot?: boolean;
  className?: string;
}

const TONE_CLASS: Record<BadgeTone, string> = {
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-danger',
  info: 'badge-info',
  neutral: 'badge-neutral',
};

export default function Badge({
  tone = 'neutral',
  children,
  dot = false,
  className = '',
}: BadgeProps) {
  return (
    <span className={`badge ${TONE_CLASS[tone]} ${dot ? 'badge-dot' : ''} ${className}`}>
      {dot && <span className="badge-dot-indicator" />}
      {children}
    </span>
  );
}
