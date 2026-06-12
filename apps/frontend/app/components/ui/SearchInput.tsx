'use client';

import { InputHTMLAttributes, forwardRef } from 'react';

// ============================================
// SearchInput — search field with icon
// Extracted from repeated patterns across pages
// ============================================

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Called when value changes */
  onValueChange?: (value: string) => void;
}

const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ onValueChange, onChange, className = '', 'aria-label': ariaLabel, ...props }, ref) => {
    return (
      <div className={`search-input-wrapper ${className}`}>
        <span className="search-icon" aria-hidden="true">⌕</span>
        <input
          ref={ref}
          type="search"
          className="search-input"
          aria-label={ariaLabel ?? props.placeholder ?? 'Search'}
          onChange={(e) => {
            onChange?.(e);
            onValueChange?.(e.target.value);
          }}
          {...props}
        />
      </div>
    );
  },
);

SearchInput.displayName = 'SearchInput';
export default SearchInput;
