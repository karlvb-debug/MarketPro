'use client';

import { useState, useEffect, useCallback, ReactNode } from 'react';

// ============================================
// Toast Notification System
// ============================================

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

let toastListeners: Array<(toast: Toast) => void> = [];

// Global function — can be called from anywhere, no hook needed
export function showToast(message: string, type: 'success' | 'error' | 'info' = 'success') {
  const toast: Toast = { id: crypto.randomUUID(), message, type };
  toastListeners.forEach((fn) => fn(toast));
}

// Provider component — mount once in layout
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const listener = (toast: Toast) => {
      setToasts((prev) => [...prev, toast]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      }, 3500);
    };
    toastListeners.push(listener);
    return () => {
      toastListeners = toastListeners.filter((fn) => fn !== listener);
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const icons: Record<string, string> = { success: '✓', error: '✕', info: 'ℹ' };

  return (
    <>
      {children}
      <div className="toast-container">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast-${toast.type}`}
            onClick={() => dismiss(toast.id)}
          >
            <span className="toast-icon">{icons[toast.type]}</span>
            <span className="toast-message">{toast.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}
