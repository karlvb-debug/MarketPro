'use client';

interface ProgressBarProps {
  value: number;    // e.g. delivered count
  total: number;    // e.g. total recipients
  showLabel?: boolean;
}

export default function ProgressBar({ value, total, showLabel = true }: ProgressBarProps) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;

  return (
    <div className="progress-bar-wrapper">
      <div className="progress-bar-track">
        <div
          className={`progress-bar-fill ${pct === 100 ? 'complete' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && <span className="progress-bar-label">{pct}%</span>}
    </div>
  );
}

// ============================================
// Metric Bar — labeled progress bar for analytics
// ============================================

interface MetricBarProps {
  label: string;
  value: number;
  total: number;
  color: string;
}

export function MetricBar({ label, value, total, color }: MetricBarProps) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;

  return (
    <div className="metric-bar">
      <div className="metric-bar-header">
        <span className="metric-bar-label">{label}</span>
        <span className="metric-bar-value">
          {value.toLocaleString()} ({pct}%)
        </span>
      </div>
      <div className="progress-bar-track" style={{ height: '8px' }}>
        <div
          className="progress-bar-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}
