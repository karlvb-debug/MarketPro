'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useStore } from '../lib/store';
import { useAuth } from '../lib/auth';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import { useMobileNav } from './MobileNav';
import ThemeToggle from './ThemeToggle';
import {
  IconBarChart,
  IconUsers,
  IconMegaphone,
  IconLayout,
  IconMessageSquare,
  IconTrendingUp,
  IconSettings,
} from './Icons';

const navItems = [
  { label: 'Overview', href: '/', icon: <IconBarChart size={16} /> },
  { label: 'Contacts', href: '/contacts', icon: <IconUsers size={16} /> },
  { label: 'Campaigns', href: '/campaigns', icon: <IconMegaphone size={16} /> },
  { label: 'Content', href: '/templates', icon: <IconLayout size={16} /> },
];

const channelItems = [
  { label: 'Inbox', href: '/inbox', icon: <IconMessageSquare size={16} />, hasBadge: true },
  { label: 'Analytics', href: '/analytics', icon: <IconTrendingUp size={16} /> },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { isOpen, close } = useMobileNav();
  const { stats } = useStore();
  const { user, signOut } = useAuth();

  const displayName = user?.name || user?.email?.split('@')[0] || 'User';
  const initials = displayName.split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2);

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && <div className="sidebar-overlay" onClick={close} />}

      <aside className={`sidebar ${isOpen ? 'sidebar-open' : ''}`}>
        <WorkspaceSwitcher />

        <nav className="sidebar-nav">
          <div className="sidebar-section-label">Main</div>
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`sidebar-link ${pathname === item.href ? 'active' : ''}`}
              onClick={close}
            >
              <span className="sidebar-link-icon">{item.icon}</span>
              {item.label}
            </Link>
          ))}

          <div className="sidebar-section-label">Channels</div>
          {channelItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`sidebar-link ${pathname === item.href ? 'active' : ''}`}
              onClick={close}
            >
              <span className="sidebar-link-icon">{item.icon}</span>
              {item.label}
              {'hasBadge' in item && stats.unreadInbox > 0 ? (
                <span className="sidebar-link-badge">{stats.unreadInbox}</span>
              ) : null}
            </Link>
          ))}
        </nav>

        <div className="sidebar-footer">
          <Link
            href="/settings"
            className={`sidebar-link ${pathname === '/settings' ? 'active' : ''}`}
            onClick={close}
          >
            <span className="sidebar-link-icon"><IconSettings size={16} /></span>
            Settings
          </Link>
          <ThemeToggle />
          <div className="sidebar-user">
            <div className="sidebar-avatar">{initials}</div>
            <div className="sidebar-user-info">
              <span className="sidebar-user-name">{displayName}</span>
              <button
                onClick={signOut}
                className="sidebar-signout-btn"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
