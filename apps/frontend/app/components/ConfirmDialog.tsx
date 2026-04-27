'use client';

import { useState, useCallback, createContext, useContext, ReactNode } from 'react';

// ============================================
// Custom Confirm Dialog — replaces browser confirm()
// Usage: const confirm = useConfirm();
//        const ok = await confirm('Delete this?', { variant: 'danger' });
// ============================================

interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'danger';
}

interface ConfirmState {
  open: boolean;
  message: string;
  options: ConfirmOptions;
  resolve: ((value: boolean) => void) | null;
}

const ConfirmContext = createContext<((message: string, options?: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState>({
    open: false,
    message: '',
    options: {},
    resolve: null,
  });

  const confirm = useCallback((message: string, options: ConfirmOptions = {}): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setState({ open: true, message, options, resolve });
    });
  }, []);

  const handleConfirm = () => {
    state.resolve?.(true);
    setState((s) => ({ ...s, open: false, resolve: null }));
  };

  const handleCancel = () => {
    state.resolve?.(false);
    setState((s) => ({ ...s, open: false, resolve: null }));
  };

  const { title, confirmLabel, cancelLabel, variant } = state.options;
  const isDanger = variant === 'danger';

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state.open && (
        <>
          <div className="confirm-overlay" onClick={handleCancel} />
          <div className="confirm-dialog" role="alertdialog" aria-modal="true">
            <div className="confirm-body">
              {title && <h3 className="confirm-title">{title}</h3>}
              <p className="confirm-message">{state.message}</p>
            </div>
            <div className="confirm-actions">
              <button className="btn btn-secondary btn-sm" onClick={handleCancel} autoFocus={!isDanger}>
                {cancelLabel || 'Cancel'}
              </button>
              <button
                className={`btn btn-sm ${isDanger ? 'btn-danger' : 'btn-primary'}`}
                onClick={handleConfirm}
                autoFocus={isDanger}
              >
                {confirmLabel || (isDanger ? 'Delete' : 'Confirm')}
              </button>
            </div>
          </div>
        </>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx;
}
