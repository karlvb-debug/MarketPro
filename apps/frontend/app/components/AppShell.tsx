'use client';

// ============================================
// AppShell — Route protection + authenticated layout
// Redirects unauthenticated users to /login
// Shows full app chrome (sidebar, etc.) only when authenticated
// ============================================

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { config } from '../lib/config';
import { WorkspaceProvider } from '../lib/workspace';
import { MobileNavProvider } from './MobileNav';
import { MobileHeader } from './MobileHeader';
import { ToastProvider } from './Toast';
import Sidebar from './Sidebar';

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading } = useAuth();

  const isLoginPage = pathname === '/login';
  const isAuthenticated = !!user;

  // Redirect to login if not authenticated (unless already on login page)
  useEffect(() => {
    if (!loading && !isAuthenticated && !isLoginPage && config.isApiConfigured) {
      router.push('/login');
    }
  }, [loading, isAuthenticated, isLoginPage, router]);

  // Loading state
  if (loading) {
    return (
      <div className="login-page">
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
          <div className="login-logo-icon" style={{ margin: '0 auto 16px', width: 48, height: 48, fontSize: 20 }}>C</div>
          <p style={{ fontSize: 'var(--text-sm)' }}>Loading...</p>
        </div>
      </div>
    );
  }

  // Login page — render without app chrome
  if (isLoginPage) {
    return <>{children}</>;
  }

  // Not authenticated and API is configured — show nothing while redirect happens
  if (!isAuthenticated && config.isApiConfigured) {
    return null;
  }

  // Authenticated (or API not configured — allow local dev) — full app layout
  return (
    <WorkspaceProvider>
      <MobileNavProvider>
        <ToastProvider>
          <div className="app-layout">
            <MobileHeader />
            <Sidebar />
            <main className="app-content">
              {children}
            </main>
          </div>
        </ToastProvider>
      </MobileNavProvider>
    </WorkspaceProvider>
  );
}
