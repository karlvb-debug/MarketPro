'use client';

import { MobileMenuButton } from './MobileNav';

/**
 * Mobile-only top bar with hamburger menu button and app name.
 * Hidden on desktop via CSS (display: none above 768px).
 */
export function MobileHeader() {
  return (
    <header className="mobile-header">
      <MobileMenuButton />
      <span className="mobile-header-title">MarketPro</span>
    </header>
  );
}
