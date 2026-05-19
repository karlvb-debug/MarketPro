'use client';

import { ReactNode } from 'react';

// ============================================
// Modal — shared overlay dialog
// Upgrade: adds size prop instead of inline maxWidth
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
  if (!isOpen) return null;

  const maxWidth = width || SIZE_MAP[size];

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content" style={{ maxWidth }}>
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button onClick={onClose} className="btn btn-ghost btn-icon modal-close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
