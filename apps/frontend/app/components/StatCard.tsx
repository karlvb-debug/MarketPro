'use client';

import { ReactNode } from 'react';

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: string;
  change?: string;
  changeType?: 'positive' | 'negative' | 'neutral';
  accent?: string; // CSS color value
}

export default function StatCard({ label, value, icon, change, changeType = 'positive', accent }: StatCardProps) {
  return (
    <div className="stat-card" style={accent ? { '--stat-accent': accent } as React.CSSProperties : undefined}>
      <div className="stat-card-header">
        <span className="stat-card-label">{label}</span>
        {icon && <span className="stat-card-icon">{icon}</span>}
      </div>
      <div className="stat-card-value">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {change && (
        <span className={`stat-card-change ${changeType}`}>
          {changeType === 'positive' ? '↑' : changeType === 'negative' ? '' : ''} {change}
        </span>
      )}
    </div>
  );
}

/* Grid wrapper for stat cards */
export function StatsGrid({ children }: { children: ReactNode }) {
  return <div className="stats-grid">{children}</div>;
}
