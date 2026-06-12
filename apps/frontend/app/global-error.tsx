'use client';

// ============================================
// Global error boundary
// Catches errors thrown by the root layout itself.
// Must render its own <html>/<body> — global CSS from
// the root layout is not available here, so styles are
// inline and theme-neutral.
// ============================================

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0b0f1a',
          color: '#f1f5f9',
          fontFamily:
            "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        <div role="alert" style={{ textAlign: 'center', padding: '48px 24px', maxWidth: 420 }}>
          <div style={{ fontSize: '3rem', opacity: 0.4, marginBottom: 16 }} aria-hidden="true">
            ⚠
          </div>
          <h2 style={{ fontSize: '1.125rem', fontWeight: 600, margin: '0 0 8px' }}>
            Something went wrong
          </h2>
          <p style={{ fontSize: '0.875rem', color: '#94a3b8', margin: '0 0 24px' }}>
            The application failed to load. You can try again — if the problem
            persists, refresh the page.
          </p>
          {error.digest && (
            <p
              style={{
                fontSize: '0.75rem',
                color: '#64748b',
                fontFamily: "'SF Mono', 'Fira Code', monospace",
                margin: '0 0 24px',
              }}
            >
              Error digest: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              padding: '8px 16px',
              fontSize: '0.8125rem',
              fontWeight: 500,
              borderRadius: 8,
              border: '1px solid #638cff',
              background: '#638cff',
              color: '#ffffff',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
