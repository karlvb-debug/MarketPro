'use client';

import { useState } from 'react';
import { useStore } from '../lib/store';
import PageHeader from '../components/PageHeader';
import StatusBadge, { SegmentBadge, ChannelIcon } from '../components/StatusBadge';
import DataTable from '../components/DataTable';
import ProgressBar from '../components/ProgressBar';
import EmptyState from '../components/EmptyState';
import Modal from '../components/Modal';
import { FormField, FormInput, FormSelect, RadioCard, FormActions } from '../components/FormElements';
import { showToast } from '../components/Toast';

export default function CampaignsPage() {
  const { campaigns, segments, templates, addCampaign, hydrated } = useStore();
  const [showWizard, setShowWizard] = useState(false);
  const [step, setStep] = useState(1);
  const [channel, setChannel] = useState<'email' | 'sms' | 'voice' | ''>('');
  const [name, setName] = useState('');
  const [segmentId, setSegmentId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [sendNow, setSendNow] = useState(true);
  const [scheduleDate, setScheduleDate] = useState('');

  const reset = () => { setShowWizard(false); setStep(1); setChannel(''); setName(''); setSegmentId(''); setTemplateId(''); setSendNow(true); setScheduleDate(''); };

  const handleCreate = () => {
    const seg = segments.find((s) => s.segmentId === segmentId);
    addCampaign({ name, channel: channel as 'email' | 'sms' | 'voice', segment: seg?.name || '', templateId: templateId || undefined, scheduledAt: sendNow ? null : scheduleDate ? new Date(scheduleDate).toISOString() : null });
    showToast(`Campaign "${name}" created`);
    reset();
  };

  const selectedSeg = segments.find((s) => s.segmentId === segmentId);
  const costPerMsg: Record<string, number> = { email: 0.001, sms: 0.0075, voice: 0.025 };
  const estCost = ((selectedSeg?.count || 0) * (costPerMsg[channel] || 0)).toFixed(2);

  if (!hydrated) return null;

  return (
    <>
      <PageHeader title="Campaigns" subtitle="Manage your email, SMS, and voice campaigns">
        <button className="btn btn-primary" onClick={() => setShowWizard(true)}>+ New Campaign</button>
      </PageHeader>

      <DataTable headers={['Campaign', 'Channel', 'Segment', 'Status', 'Delivery Progress', 'Recipients', 'Scheduled']}>
        {campaigns.map((c) => (
          <tr key={c.campaignId}>
            <td className="text-primary font-medium">{c.name}</td>
            <td><ChannelIcon channel={c.channel} /></td>
            <td><SegmentBadge name={c.segment} /></td>
            <td><StatusBadge status={c.status} /></td>
            <td style={{ minWidth: '140px' }}><ProgressBar value={c.delivered} total={c.totalRecipients} /></td>
            <td>{c.totalRecipients > 0 ? c.totalRecipients.toLocaleString() : '—'}</td>
            <td className="text-tertiary">{c.scheduledAt ? new Date(c.scheduledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</td>
          </tr>
        ))}
        {campaigns.length === 0 && (
          <tr><td colSpan={7}>
            <EmptyState icon="▷" title="No campaigns yet" description="Create your first campaign to start reaching your audience.">
              <button className="btn btn-primary" onClick={() => setShowWizard(true)}>+ New Campaign</button>
            </EmptyState>
          </td></tr>
        )}
      </DataTable>

      {/* NEW CAMPAIGN WIZARD */}
      <Modal isOpen={showWizard} onClose={reset} title="Create New Campaign" width="620px">
        {/* Step indicator */}
        <div className="wizard-steps">
          {['Channel', 'Details', 'Schedule'].map((label, i) => (
            <div key={label} className="wizard-step">
              <div className={`wizard-step-circle ${step > i + 1 ? 'completed' : step === i + 1 ? 'active' : 'inactive'}`}>
                {step > i + 1 ? '✓' : i + 1}
              </div>
              <span className={`wizard-step-label ${step === i + 1 ? 'active' : 'inactive'}`}>{label}</span>
              {i < 2 && <div className="wizard-step-line" />}
            </div>
          ))}
        </div>

        {step === 1 && (
          <>
            <p className="text-secondary" style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-5)' }}>How do you want to reach your audience?</p>
            <div className="form-grid-3">
              {[{ id: 'email', icon: '@', label: 'Email', desc: 'HTML newsletters & promos' }, { id: 'sms', icon: '#', label: 'SMS', desc: 'Text messages & alerts' }, { id: 'voice', icon: '☎', label: 'Voice', desc: 'Automated calls & IVR' }].map((ch) => (
                <div key={ch.id} className={`channel-card ${channel === ch.id ? 'selected' : ''}`} onClick={() => setChannel(ch.id as typeof channel)}>
                  <div className="channel-card-icon">{ch.icon}</div>
                  <div className="channel-card-label">{ch.label}</div>
                  <div className="channel-card-desc">{ch.desc}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-6)' }}>
              <button className="btn btn-primary" disabled={!channel} onClick={() => setStep(2)}>Continue →</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <FormField label="Campaign Name" required><FormInput placeholder="e.g. Summer Sale Blast" required value={name} onChange={(e) => setName(e.target.value)} /></FormField>
            <FormField label="Target Segment" required hint="All contacts in this segment will receive the campaign">
              <FormSelect value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
                <option value="">Select a segment...</option>
                {segments.map((s) => <option key={s.segmentId} value={s.segmentId}>{s.name} ({s.count} contacts)</option>)}
              </FormSelect>
            </FormField>
            <FormField label="Template" hint={`Choose a ${channel} template to use`}>
              <FormSelect value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">Select a template...</option>
                {channel === 'email' && templates.email.map((t) => <option key={t.templateId} value={t.templateId}>{t.name}</option>)}
                {channel === 'sms' && templates.sms.map((t) => <option key={t.templateId} value={t.templateId}>{t.name}</option>)}
                {channel === 'voice' && templates.voice.map((t) => <option key={t.scriptId} value={t.scriptId}>{t.name}</option>)}
              </FormSelect>
            </FormField>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-6)' }}>
              <button className="btn btn-secondary" onClick={() => setStep(1)}>← Back</button>
              <button className="btn btn-primary" disabled={!name || !segmentId} onClick={() => setStep(3)}>Continue →</button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <FormField label="When to Send" required>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                <RadioCard name="schedule" label="Save as Draft" description="Save now and send later when you're ready" checked={sendNow} onChange={() => setSendNow(true)} />
                <RadioCard name="schedule" label="Schedule for later" description="Pick a date and time" checked={!sendNow} onChange={() => setSendNow(false)} />
              </div>
            </FormField>
            {!sendNow && <FormField label="Send Date & Time"><FormInput type="datetime-local" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} /></FormField>}
            <div className="cost-estimate">
              <div className="flex items-center justify-between">
                <span className="text-secondary" style={{ fontSize: 'var(--text-sm)' }}>Estimated Cost</span>
                <span className="text-primary font-bold" style={{ fontSize: 'var(--text-lg)' }}>${estCost}</span>
              </div>
              <p className="text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 'var(--space-1)' }}>
                {selectedSeg?.count || 0} recipients × ${costPerMsg[channel] || 0}/msg
              </p>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-6)' }}>
              <button className="btn btn-secondary" onClick={() => setStep(2)}>← Back</button>
              <button className="btn btn-primary" onClick={handleCreate}>Create Campaign</button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
