'use client';

import { ReactNode, HTMLAttributes } from 'react';

// ============================================
// Card — simple container with consistent styling
// ============================================

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Enable hover elevation effect */
  hover?: boolean;
  /** Padding preset */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  children: ReactNode;
}

const PADDING_CLASS: Record<string, string> = {
  none: 'card-p-none',
  sm: 'card-p-sm',
  md: '',        // default card padding
  lg: 'card-p-lg',
};

export default function Card({
  hover = false,
  padding = 'md',
  children,
  className = '',
  ...rest
}: CardProps) {
  const classes = [
    'card',
    hover ? 'card-hover' : '',
    PADDING_CLASS[padding],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}
