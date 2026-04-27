'use client';

import { useStore } from './lib/store';
import PageHeader from './components/PageHeader';
import StatCard, { StatsGrid } from './components/StatCard';
import StatusBadge, { ChannelIcon } from './components/StatusBadge';
import DataTable, { Card } from './components/DataTable';
import EmptyState from './components/EmptyState';

export default function DashboardPage() {
  const { stats, campaigns, hydrated } = useStore();
  const recentCampaigns = campaigns.slice(0, 5);

  if (!hydrated) return null;

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Welcome back — here's your marketing overview.">
        <a href="/campaigns" className="btn btn-primary">+ New Campaign</a>
      </PageHeader>

      <StatsGrid>
        <StatCard label="Total Contacts" value={stats.totalContacts} icon="○" change={stats.contactsChange} accent="var(--accent-primary)" />
        <StatCard label="Active Campaigns" value={stats.activeCampaigns} icon="▷" change={`+${stats.campaignsChange}`} accent="var(--accent-success)" />
        <StatCard label="Messages Sent" value={stats.messagesSent} icon="→" change={stats.messagesChange} accent="var(--accent-info)" />
        <StatCard label="Unread Inbox" value={stats.unreadInbox} icon="#" change={`+ ${stats.inboxChange} new`} changeType="negative" accent="var(--accent-warning)" />
      </StatsGrid>

      <Card title="Recent Campaigns" action={<a href="/campaigns" className="btn btn-ghost btn-sm">View all →</a>}>
        <DataTable headers={['Campaign', 'Channel', 'Status', 'Recipients', 'Delivered', 'Scheduled']} noBorder>
          {recentCampaigns.map((c) => (
            <tr key={c.campaignId}>
              <td className="text-primary font-medium">{c.name}</td>
              <td><ChannelIcon channel={c.channel} /></td>
              <td><StatusBadge status={c.status} /></td>
              <td>{c.totalRecipients.toLocaleString()}</td>
              <td>{c.delivered.toLocaleString()}</td>
              <td className="text-tertiary">
                {c.scheduledAt
                  ? new Date(c.scheduledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                  : '—'}
              </td>
            </tr>
          ))}
          {recentCampaigns.length === 0 && (
            <tr><td colSpan={6}>
              <EmptyState icon="▷" title="No campaigns yet" description="Create your first campaign to get started." />
            </td></tr>
          )}
        </DataTable>
      </Card>
    </>
  );
}
