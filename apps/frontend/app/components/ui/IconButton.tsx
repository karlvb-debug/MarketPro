'use client';

import { forwardRef } from 'react';
import Button, { ButtonProps } from './Button';

// ============================================
// IconButton — square icon-only button with tooltip
// ============================================

export interface IconButtonProps extends Omit<ButtonProps, 'iconOnly' | 'children'> {
  /** Accessible label (rendered as title + aria-label) */
  label: string;
}

const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, variant = 'ghost', ...rest }, ref) => {
    return (
      <Button
        ref={ref}
        variant={variant}
        iconOnly
        title={label}
        aria-label={label}
        {...rest}
      />
    );
  },
);

IconButton.displayName = 'IconButton';
export default IconButton;
