'use client';

import { forwardRef, ButtonHTMLAttributes, ReactNode } from 'react';

// ============================================
// Button — shared primitive
// Maps to existing .btn CSS classes in globals.css
// ============================================

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render as icon-only (square, no text padding) */
  iconOnly?: boolean;
  /** Show a loading spinner and disable interaction */
  loading?: boolean;
  /** Optional leading icon */
  icon?: ReactNode;
  children?: ReactNode;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'secondary',
      size = 'md',
      iconOnly = false,
      loading = false,
      icon,
      children,
      className = '',
      disabled,
      ...rest
    },
    ref,
  ) => {
    const classes = [
      'btn',
      `btn-${variant}`,
      size !== 'md' ? `btn-${size}` : '',
      iconOnly ? 'btn-icon' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <button
        ref={ref}
        className={classes}
        disabled={disabled || loading}
        {...rest}
      >
        {loading ? (
          <span className="btn-spinner" aria-hidden="true" />
        ) : (
          <>
            {icon && <span className="btn-icon-slot">{icon}</span>}
            {children}
          </>
        )}
      </button>
    );
  },
);

Button.displayName = 'Button';
export default Button;
