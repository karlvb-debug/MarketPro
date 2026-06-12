'use client';

import { ReactNode, useEffect, useId, useRef } from 'react';

// ============================================
// Modal — shared overlay dialog
// Upgrade: adds size prop instead of inline maxWidth
// A11y: dialog semantics, Escape-to-close, focus
// moves into the dialog on open.
// ============================================

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_MAP: Record<ModalSize, string> = {
  sm: '400px',
  md: '520px',
  lg: '740px',
  xl: '960px',
};

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Preset size or a custom CSS width string */
  size?: ModalSize;
  /** Override with a custom width (takes precedence over size) */
  width?: string;
}

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = 'md',
  width,
}: ModalProps) {
  const titleId = useId();
  const contentRef = useRef<HTMLDivElement>(null);

  // Escape-to-close while open
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Move focus into the dialog on open (unless something inside
  // already grabbed it, e.g. an autoFocus input)
  useEffect(() => {
    if (!isOpen) return;
    const content = contentRef.current;
    if (content && !content.contains(document.activeElement)) {
      content.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const maxWidth = width || SIZE_MAP[size];

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={contentRef}
        className="modal-content"
        style={{ maxWidth }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2 className="modal-title" id={titleId}>{title}</h2>
          <button
            onClick={onClose}
            className="btn btn-ghost btn-icon modal-close"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
