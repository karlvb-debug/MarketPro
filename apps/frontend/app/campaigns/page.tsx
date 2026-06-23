'use client';

import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { validateEmailCompliance, applyMergeSamples } from '../lib/email-compiler';
import PageHeader from '../components/PageHeader';
import StatusBadge, { SegmentBadge, ChannelIcon } from '../components/StatusBadge';
import DataTable from '../components/DataTable';
import ProgressBar from '../components/ProgressBar';
import { Button, EmptyState, LoadingState, Modal, Field, Input, Select, RadioCard } from '../components/ui';

type CheckStatus = 'pass' | 'warn' | 'fail';
interface CheckItem { key: string; label: string; status: CheckStatus; hint?: string }

const CHECK_ICON: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '✕' };

interface CreditShortfall { required: number; available: number; recipients: number }
interface SentInfo { name: string; recipients: number; scheduled: boolean }

export default function CampaignsPage() {
  const { campaigns, segments, templates, settings, addCampaign, hydrated } = useStore();
  const [showWizard, setShowWizard] = useState(false);
  const [step, setStep] = useState(1);
  const [channel, setChannel] = useState<'email' | 'sms' | 'voice' | ''>('');
  const [name, setName] = useState('');
  const [segmentId, setSegmentId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [sendNow, setSendNow] = useState(true);
  const [scheduleDate, setScheduleDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [creditError, setCreditError] = useState<CreditShortfall | null>(null);
  const [sentInfo, setSentInfo] = useState<SentInfo | null>(null);

  const reset = () => {
    setShowWizard(false); setStep(1); setChannel(''); setName(''); setSegmentId('');
    setTemplateId(''); setSendNow(true); setScheduleDate('');
    setSubmitting(false); setCreditError(null); setSentInfo(null);
  };

  const selectedSeg = segments.find((s) => s.segmentId === segmentId);
  const audience = selectedSeg?.count || 0;
  const costPerMsg: Record<string, number> = { email: 0.001, sms: 0.0075, voice: 0.025 };
  const estCost = (audience * (costPerMsg[channel] || 0)).toFixed(2);

  const selectedEmailTemplate = channel === 'email'
    ? templates.email.find((t) => t.templateId === templateId)
    : undefined;

  // Rendered preview of the actual email dispatch will send, with sample
  // merge-tag values resolved so the user sees a realistic inbox view.
  const previewHtml = useMemo(() => {
    if (!selectedEmailTemplate?.htmlContent) return '';
    return applyMergeSamples(selectedEmailTemplate.htmlContent);
  }, [selectedEmailTemplate]);

  // Pre-send checklist — hard failures block the send, warnings inform.
  const checklist = useMemo<CheckItem[]>(() => {
    const items: CheckItem[] = [];

    if (channel === 'email') {
      const tpl = selectedEmailTemplate;
      items.push({
        key: 'content',
        label: 'Email content present',
        status: tpl?.htmlContent ? 'pass' : 'fail',
        hint: tpl?.htmlContent ? undefined : 'Select a template with a built design.',
      });
      items.push({
        key: 'subject',
        label: 'Subject line set',
        status: tpl?.subjectLine?.trim() ? 'pass' : 'fail',
        hint: tpl?.subjectLine?.trim() ? undefined : 'Open the template in the builder and add a subject.',
      });
      items.push({
        key: 'preview',
        label: 'Preview text set',
        status: tpl?.editorJson?.previewText?.trim() ? 'pass' : 'warn',
        hint: tpl?.editorJson?.previewText?.trim() ? undefined : 'Inbox snippet will fall back to body text.',
      });

      // Compliance (unsubscribe + physical address) from the saved design.
      if (tpl?.editorJson) {
        const warnings = validateEmailCompliance(tpl.editorJson, settings.businessAddress);
        const hasError = warnings.some((w) => w.severity === 'error');
        items.push({
          key: 'compliance',
          label: 'Unsubscribe & footer compliance',
          status: hasError ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
          hint: warnings[0]?.message,
        });
      } else {
        items.push({
          key: 'compliance',
          label: 'Unsubscribe & footer compliance',
          status: 'warn',
          hint: 'No saved design to verify — re-save the template in the builder.',
        });
      }

      items.push({
        key: 'from',
        label: 'From address configured',
        status: settings.emailFromAddress?.trim() ? 'pass' : 'warn',
        hint: settings.emailFromAddress?.trim()
          ? undefined
          : 'Set a verified sender in Settings before a real send.',
      });
    } else {
      items.push({
        key: 'template',
        label: `${channel === 'sms' ? 'SMS' : 'Voice'} template selected`,
        status: templateId ? 'pass' : 'warn',
        hint: templateId ? undefined : 'No template chosen.',
      });
    }

    items.push({
      key: 'audience',
      label: 'Audience has recipients',
      status: audience > 0 ? 'pass' : 'fail',
      hint: audience > 0 ? `${audience.toLocaleString()} contacts` : 'This segment is empty.',
    });

    return items;
  }, [channel, selectedEmailTemplate, templateId, audience, settings.businessAddress, settings.emailFromAddress]);

  const hardFail = checklist.some((c) => c.status === 'fail');

  const handleCreate = async () => {
    if (!selectedSeg) return;
    setSubmitting(true);
    setCreditError(null);
    const scheduledAt = sendNow ? null : scheduleDate ? new Date(scheduleDate).toISOString() : null;
    const result = await addCampaign({
      name,
      channel: channel as 'email' | 'sms' | 'voice',
      segment: selectedSeg.name,
      segmentId,
      recipientCount: audience,
      templateId: templateId || undefined,
      scheduledAt,
    });
    setSubmitting(false);

    if (result.ok) {
      setSentInfo({ name, recipients: audience, scheduled: !sendNow });
    } else if (result.reason === 'insufficient_funds') {
      setCreditError({ required: result.required, available: result.available, recipients: result.recipients });
    }
    // 'error' reason is already surfaced via toast in the store slice.
  };

  if (!hydrated) return <LoadingState />;

  return (
    <>
      <PageHeader title="Campaigns" subtitle="Manage your email, SMS, and voice campaigns">
        <Button variant="primary" onClick={() => setShowWizard(true)}>+ New Campaign</Button>
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
              <Button variant="primary" onClick={() => setShowWizard(true)}>+ New Campaign</Button>
            </EmptyState>
          </td></tr>
        )}
      </DataTable>

      {/* NEW CAMPAIGN WIZARD */}
      <Modal isOpen={showWizard} onClose={reset} title="Create New Campaign" size="lg">
        {/* Success confirmation — replaces the wizard once the send/schedule lands */}
        {sentInfo ? (
          <div className="text-center py-6">
            <div className="text-4xl mb-3">{sentInfo.scheduled ? '🗓️' : '✓'}</div>
            <h3 className="text-primary font-bold text-lg mb-1">
              {sentInfo.scheduled ? 'Campaign scheduled' : 'Campaign launched'}
            </h3>
            <p className="text-secondary text-sm mb-5">
              “{sentInfo.name}” {sentInfo.scheduled ? 'is queued to send to' : 'is now sending to'}{' '}
              {sentInfo.recipients.toLocaleString()} recipient{sentInfo.recipients === 1 ? '' : 's'}.
              Track per-recipient delivery progress in the campaigns list below.
            </p>
            <Button variant="primary" onClick={reset}>View Campaigns</Button>
          </div>
        ) : creditError ? (
          /* 402 — insufficient credits */
          <div className="py-4">
            <div className="text-center mb-4">
              <div className="text-4xl mb-2">💳</div>
              <h3 className="text-primary font-bold text-lg">Not enough credits</h3>
            </div>
            <div className="cost-estimate" style={{ marginBottom: '1rem' }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-secondary text-sm">This send requires</span>
                <span className="text-primary font-bold">${creditError.required.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-secondary text-sm">Available balance</span>
                <span className="text-primary font-bold">${creditError.available.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-secondary text-sm">Shortfall</span>
                <span className="text-danger font-bold">
                  ${Math.max(0, creditError.required - creditError.available).toFixed(2)}
                </span>
              </div>
            </div>
            <p className="text-tertiary text-xs mb-5">
              Nothing was charged and no messages were sent — the campaign was not launched.
              Add credits to your workspace balance, or pick a smaller segment
              ({creditError.recipients.toLocaleString()} eligible recipients), then try again.
            </p>
            <div className="flex justify-between">
              <Button onClick={reset}>Cancel</Button>
              <Button variant="primary" onClick={() => setCreditError(null)}>Back to review</Button>
            </div>
          </div>
        ) : (
          <>
            {/* Step indicator */}
            <div className="wizard-steps">
              {['Channel', 'Details', 'Review & Send'].map((label, i) => (
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
                <p className="text-secondary text-sm mb-5">How do you want to reach your audience?</p>
                <div className="form-grid-3">
                  {[{ id: 'email', icon: '@', label: 'Email', desc: 'HTML newsletters & promos' }, { id: 'sms', icon: '#', label: 'SMS', desc: 'Text messages & alerts' }, { id: 'voice', icon: '☎', label: 'Voice', desc: 'Automated calls & IVR' }].map((ch) => (
                    <div key={ch.id} className={`channel-card ${channel === ch.id ? 'selected' : ''}`} onClick={() => { setChannel(ch.id as typeof channel); setTemplateId(''); }}>
                      <div className="channel-card-icon">{ch.icon}</div>
                      <div className="channel-card-label">{ch.label}</div>
                      <div className="channel-card-desc">{ch.desc}</div>
                    </div>
                  ))}
                </div>
                <div className="flex justify-end mt-6">
                  <Button variant="primary" disabled={!channel} onClick={() => setStep(2)}>Continue →</Button>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <Field label="Campaign Name" required><Input placeholder="e.g. Summer Sale Blast" required value={name} onChange={(e) => setName(e.target.value)} /></Field>
                <Field label="Target Segment" required hint="All contacts in this segment will receive the campaign">
                  <Select value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
                    <option value="">Select a segment...</option>
                    {segments.map((s) => <option key={s.segmentId} value={s.segmentId}>{s.name} ({s.count} contacts)</option>)}
                  </Select>
                </Field>
                <Field label="Template" hint={`Choose a ${channel} template to use`}>
                  <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                    <option value="">Select a template...</option>
                    {channel === 'email' && templates.email.map((t) => <option key={t.templateId} value={t.templateId}>{t.name}</option>)}
                    {channel === 'sms' && templates.sms.map((t) => <option key={t.templateId} value={t.templateId}>{t.name}</option>)}
                    {channel === 'voice' && templates.voice.map((t) => <option key={t.scriptId} value={t.scriptId}>{t.name}</option>)}
                  </Select>
                </Field>

                {/* Live preview of the actual rendered email + audience snapshot */}
                {channel === 'email' && selectedEmailTemplate && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-secondary text-sm font-medium">Preview</span>
                      <span className="text-tertiary text-xs">
                        Subject: {selectedEmailTemplate.subjectLine?.trim() || <em>none set</em>}
                      </span>
                    </div>
                    {previewHtml ? (
                      <iframe
                        title="Email preview"
                        srcDoc={previewHtml}
                        sandbox=""
                        style={{ width: '100%', height: '320px', border: '1px solid var(--border, #e2e8f0)', borderRadius: '8px', background: '#fff' }}
                      />
                    ) : (
                      <div className="text-tertiary text-xs" style={{ padding: '1rem', border: '1px dashed var(--border, #e2e8f0)', borderRadius: '8px' }}>
                        This template has no saved design yet — open it in the builder and save to generate the email body.
                      </div>
                    )}
                  </div>
                )}

                {selectedSeg && (
                  <div className="cost-estimate mt-4">
                    <div className="flex items-center justify-between">
                      <span className="text-secondary text-sm">Audience</span>
                      <span className="text-primary font-bold">{audience.toLocaleString()} recipients</span>
                    </div>
                    <p className="text-tertiary text-xs mt-1">
                      Estimated cost ${estCost} · {audience.toLocaleString()} × ${costPerMsg[channel] || 0}/msg
                    </p>
                  </div>
                )}

                <div className="flex justify-between mt-6">
                  <Button onClick={() => setStep(1)}>← Back</Button>
                  <Button variant="primary" disabled={!name || !segmentId} onClick={() => setStep(3)}>Continue →</Button>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                {/* Pre-send checklist */}
                <div className="mb-5">
                  <span className="text-secondary text-sm font-medium">Pre-send checklist</span>
                  <ul className="mt-2" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {checklist.map((c) => (
                      <li key={c.key} className="flex items-start gap-2">
                        <span
                          aria-hidden
                          style={{
                            flexShrink: 0, width: '18px', height: '18px', borderRadius: '50%',
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '11px', fontWeight: 700, color: '#fff', marginTop: '1px',
                            background: c.status === 'pass' ? '#16a34a' : c.status === 'warn' ? '#d97706' : '#dc2626',
                          }}
                        >{CHECK_ICON[c.status]}</span>
                        <span className="text-sm">
                          <span className="text-primary">{c.label}</span>
                          {c.hint && <span className="text-tertiary"> — {c.hint}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {hardFail && (
                    <p className="text-danger text-xs mt-2">
                      Resolve the items marked ✕ before sending.
                    </p>
                  )}
                </div>

                <Field label="When to Send" required>
                  <div className="flex flex-col gap-3">
                    <RadioCard name="schedule" label="Send Now" description="Launch immediately — recipients start receiving right away" checked={sendNow} onChange={() => setSendNow(true)} />
                    <RadioCard name="schedule" label="Schedule for later" description="Pick a date and time; credits are checked at send time" checked={!sendNow} onChange={() => setSendNow(false)} />
                  </div>
                </Field>
                {!sendNow && <Field label="Send Date & Time"><Input type="datetime-local" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} /></Field>}

                <div className="cost-estimate">
                  <div className="flex items-center justify-between">
                    <span className="text-secondary text-sm">Estimated Cost</span>
                    <span className="text-primary font-bold text-lg">${estCost}</span>
                  </div>
                  <p className="text-tertiary text-xs mt-1">
                    {audience.toLocaleString()} recipients × ${costPerMsg[channel] || 0}/msg
                  </p>
                </div>

                <div className="flex justify-between mt-6">
                  <Button onClick={() => setStep(2)} disabled={submitting}>← Back</Button>
                  <Button
                    variant="primary"
                    disabled={hardFail || submitting || (!sendNow && !scheduleDate)}
                    onClick={handleCreate}
                  >
                    {submitting ? 'Working…' : sendNow ? 'Send Now' : 'Schedule Send'}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
