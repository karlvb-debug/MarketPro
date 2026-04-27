'use client';

import { useStore } from '../lib/store';
import PageHeader from '../components/PageHeader';
import StatCard, { StatsGrid } from '../components/StatCard';
import { MetricBar } from '../components/ProgressBar';
import DataTable, { Card } from '../components/DataTable';
import EmptyState from '../components/EmptyState';

export default function AnalyticsPage() {
  const { campaigns, hydrated } = useStore();

  const completedCampaigns = campaigns.filter(c => c.status === 'completed');
  const totals = completedCampaigns.reduce((acc, c) => ({
    sent: acc.sent + c.totalRecipients,
    delivered: acc.delivered + c.delivered,
    opened: acc.opened + (c.opened || 0),
    clicked: acc.clicked + (c.clicked || 0),
    bounced: acc.bounced + c.bounced,
  }), { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0 });

  if (!hydrated) return null;

  return (
    <>
      <PageHeader title="Analytics" subtitle="Campaign performance across all channels">
        <button className="btn btn-secondary btn-sm">Last 7 days ▾</button>
        <button className="btn btn-secondary btn-sm">Export</button>
      </PageHeader>

      <StatsGrid>
        <StatCard label="Total Sent" value={totals.sent} accent="var(--accent-info)" />
        <StatCard label="Delivery Rate" value={`${totals.sent > 0 ? Math.round((totals.delivered / totals.sent) * 100) : 0}%`} accent="var(--accent-success)" />
        <StatCard label="Open Rate" value={`${totals.delivered > 0 ? Math.round((totals.opened / totals.delivered) * 100) : 0}%`} accent="var(--accent-primary)" />
        <StatCard label="Click Rate" value={`${totals.delivered > 0 ? Math.round((totals.clicked / totals.delivered) * 100) : 0}%`} accent="var(--accent-warning)" />
      </StatsGrid>

      <Card title="Delivery Funnel" className="mb-6">
        <MetricBar label="Delivered" value={totals.delivered} total={totals.sent} color="var(--accent-success)" />
        <MetricBar label="Opened" value={totals.opened} total={totals.delivered} color="var(--accent-primary)" />
        <MetricBar label="Clicked" value={totals.clicked} total={totals.delivered} color="var(--accent-warning)" />
        <MetricBar label="Bounced" value={totals.bounced} total={totals.sent} color="var(--accent-danger)" />
      </Card>

      <Card title="Campaign Results">
        <DataTable headers={['Campaign', 'Channel', 'Sent', 'Delivered', 'Opened', 'Clicked', 'Bounced']} noBorder>
          {completedCampaigns.map((c) => (
            <tr key={c.campaignId}>
              <td className="text-primary font-medium">{c.name}</td>
              <td>{c.channel.toUpperCase()}</td>
              <td>{c.totalRecipients.toLocaleString()}</td>
              <td className="text-success">{c.delivered.toLocaleString()}</td>
              <td>{c.opened !== null ? c.opened.toLocaleString() : '—'}</td>
              <td>{c.clicked !== null ? c.clicked.toLocaleString() : '—'}</td>
              <td className="text-danger">{c.bounced.toLocaleString()}</td>
            </tr>
          ))}
          {completedCampaigns.length === 0 && (
            <tr><td colSpan={7}>
              <EmptyState icon="—" title="No completed campaigns" description="Results will appear here once campaigns are completed." />
            </td></tr>
          )}
        </DataTable>
      </Card>
    </>
  );
}
