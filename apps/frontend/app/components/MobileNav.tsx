'use client';

import { createContext, useContext, useState, ReactNode } from 'react';

/**
 * Mobile navigation context — controls sidebar visibility on small screens.
 * Wrap the app with <MobileNavProvider>, then use useMobileNav() in components.
 */

interface MobileNavContextType {
  isOpen: boolean;
  toggle: () => void;
  open: () => void;
  close: () => void;
}

const MobileNavContext = createContext<MobileNavContextType>({
  isOpen: false,
  toggle: () => {},
  open: () => {},
  close: () => {},
});

export function useMobileNav() {
  return useContext(MobileNavContext);
}

export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const value: MobileNavContextType = {
    isOpen,
    toggle: () => setIsOpen((prev) => !prev),
    open: () => setIsOpen(true),
    close: () => setIsOpen(false),
  };

  return (
    <MobileNavContext.Provider value={value}>
      {children}
    </MobileNavContext.Provider>
  );
}

/**
 * Hamburger button — shown only on mobile (hidden via CSS on desktop).
 * Place this in the layout or toolbar.
 */
export function MobileMenuButton() {
  const { toggle } = useMobileNav();

  return (
    <button className="mobile-menu-btn" onClick={toggle} aria-label="Toggle navigation">
      <span className="mobile-menu-icon">
        <span /><span /><span />
      </span>
    </button>
  );
}
