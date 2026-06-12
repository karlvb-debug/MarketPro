'use client';

// ============================================
// LoadingState — minimal centered spinner
// Shared placeholder shown while client-side
// state (store / workspace) hydrates.
// ============================================

export interface LoadingStateProps {
  /** Accessible + visible label (default "Loading…") */
  label?: string;
}

export default function LoadingState({ label = 'Loading…' }: LoadingStateProps) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="loading-spinner" aria-hidden="true" />
      <span className="loading-state-label">{label}</span>
    </div>
  );
}
