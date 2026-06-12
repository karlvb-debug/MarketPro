'use client';

// ============================================
// Root segment error boundary
// Catches render/runtime errors below the root
// layout and offers a retry without a full reload.
// ============================================

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="empty-state" role="alert">
      <div className="empty-state-icon" aria-hidden="true">⚠</div>
      <h2 className="empty-state-title">Something went wrong</h2>
      <p className="empty-state-text">
        An unexpected error occurred while rendering this page. You can try
        again — if the problem persists, refresh the page.
      </p>
      {error.digest && (
        <p
          className="empty-state-text font-mono"
          style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}
        >
          Error digest: {error.digest}
        </p>
      )}
      <button type="button" className="btn btn-primary" onClick={() => reset()}>
        Try again
      </button>
    </div>
  );
}
