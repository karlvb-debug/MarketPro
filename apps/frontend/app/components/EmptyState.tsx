'use client';

import { ReactNode } from 'react';

interface EmptyStateProps {
  icon: string;
  title: string;
  description?: string;
  children?: ReactNode; // CTA button
}

export default function EmptyState({ icon, title, description, children }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon}</div>
      <div className="empty-state-title">{title}</div>
      {description && <div className="empty-state-text">{description}</div>}
      {children}
    </div>
  );
}
