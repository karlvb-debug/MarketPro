'use client';

import { useState } from 'react';
import { useStore } from '../lib/store';
import PageHeader from '../components/PageHeader';
import Tabs from '../components/Tabs';
import EmptyState from '../components/EmptyState';
import Modal from '../components/Modal';
import { FormField, FormInput, FormTextarea, FormActions } from '../components/FormElements';
import { showToast } from '../components/Toast';

export default function TemplatesPage() {
  const { templates, addSmsTemplate, hydrated } = useStore();
  const [activeTab, setActiveTab] = useState('email');
  const [showNewSms, setShowNewSms] = useState(false);
  const [smsName, setSmsName] = useState('');
  const [smsBody, setSmsBody] = useState('');

  const handleAddSms = (e: React.FormEvent) => {
    e.preventDefault();
    addSmsTemplate({ name: smsName, body: smsBody });
    showToast(`Template "${smsName}" created`);
    setSmsName(''); setSmsBody(''); setShowNewSms(false);
  };

  const tabList = [
    { id: 'email', label: 'Email', icon: '✉️', count: templates.email.length },
    { id: 'sms', label: 'SMS', icon: '💬', count: templates.sms.length },
    { id: 'voice', label: 'Voice', icon: '📞', count: templates.voice.length },
  ];

  if (!hydrated) return null;

  return (
    <>
      <PageHeader title="Templates" subtitle="Design reusable templates for your campaigns">
        <button className="btn btn-primary" onClick={() => {
          if (activeTab === 'sms') setShowNewSms(true);
          else if (activeTab === 'email') window.location.href = '/email-builder';
        }}>
          {activeTab === 'email' ? '+ New Email Template' : activeTab === 'sms' ? '+ New SMS Template' : '+ New Call Script'}
        </button>
      </PageHeader>

      <Tabs tabs={tabList} activeTab={activeTab} onTabChange={setActiveTab} />

      {activeTab === 'email' && (
        <div className="template-grid">
          {templates.email.map((t) => (
            <div key={t.templateId} className="card" style={{ cursor: 'pointer' }}>
              <div className="template-preview">✉️</div>
              <h3 className="font-semibold text-primary" style={{ fontSize: 'var(--text-base)', marginBottom: 'var(--space-1)' }}>{t.name}</h3>
              <p className="text-secondary" style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-3)' }}>Subject: {t.subjectLine}</p>
              <p className="text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>Updated {new Date(t.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
            </div>
          ))}
          <a href="/email-builder" className="card template-add-card">
            <span style={{ fontSize: '2rem', marginBottom: 'var(--space-3)', opacity: 0.4 }}>+</span>
            <span className="text-secondary" style={{ fontSize: 'var(--text-sm)' }}>Create new template</span>
          </a>
        </div>
      )}

      {activeTab === 'sms' && (
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          {templates.sms.map((t) => (
            <div key={t.templateId} className="card" style={{ cursor: 'pointer' }}>
              <div className="flex items-center justify-between" style={{ marginBottom: 'var(--space-3)' }}>
                <h3 className="font-semibold text-primary" style={{ fontSize: 'var(--text-base)' }}>{t.name}</h3>
                <span className="badge badge-neutral">{t.estimatedSegments} segment{t.estimatedSegments > 1 ? 's' : ''}</span>
              </div>
              <div className="sms-preview">{t.body}</div>
            </div>
          ))}
          {templates.sms.length === 0 && (
            <EmptyState icon="💬" title="No SMS templates yet" description="Create your first SMS template.">
              <button className="btn btn-primary" onClick={() => setShowNewSms(true)}>+ New SMS Template</button>
            </EmptyState>
          )}
        </div>
      )}

      {activeTab === 'voice' && (
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          {templates.voice.map((t) => (
            <div key={t.scriptId} className="card" style={{ cursor: 'pointer' }}>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-primary" style={{ fontSize: 'var(--text-base)', marginBottom: 'var(--space-1)' }}>{t.name}</h3>
                  <p className="text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>Voice: {t.voiceId} · Updated {new Date(t.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
                </div>
                <div className="flex gap-2">
                  <button className="btn btn-secondary btn-sm">▶ Preview</button>
                  <button className="btn btn-ghost btn-sm">Edit</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={showNewSms} onClose={() => setShowNewSms(false)} title="New SMS Template">
        <form onSubmit={handleAddSms}>
          <FormField label="Template Name" required><FormInput placeholder="e.g. Appointment Reminder" required value={smsName} onChange={(e) => setSmsName(e.target.value)} /></FormField>
          <FormField label="Message Body" required hint={`${smsBody.length}/160 characters · ${Math.ceil(smsBody.length / 160) || 1} SMS segment(s)`}>
            <FormTextarea placeholder="Hi {{first_name}}, this is a reminder..." required value={smsBody} onChange={(e) => setSmsBody(e.target.value)} style={{ minHeight: '120px' }} />
          </FormField>
          <div className="info-box" style={{ marginBottom: 'var(--space-5)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            💡 <strong>Merge tags:</strong> Use {'{{first_name}}'}, {'{{last_name}}'}, {'{{company}}'}, {'{{link}}'} for personalization. Always end with &quot;Reply STOP to opt out.&quot;
          </div>
          <FormActions>
            <button type="button" className="btn btn-secondary" onClick={() => setShowNewSms(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">Save Template</button>
          </FormActions>
        </form>
      </Modal>
    </>
  );
}
