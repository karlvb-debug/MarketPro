'use client';

import { useState, useMemo } from 'react';
import { useStore, InboxMessage } from '../lib/store';
import PageHeader from '../components/PageHeader';
import { Button, EmptyState, SearchInput } from '../components/ui';

type InboxChannel = 'sms' | 'email' | 'form';

const CHANNEL_CONFIG: Record<InboxChannel, { label: string; icon: string }> = {
  sms: { label: 'SMS', icon: '#' },
  email: { label: 'Email', icon: '@' },
  form: { label: 'Form Submissions', icon: '☐' },
};

export default function InboxPage() {
  const { inbox, markRead, hydrated } = useStore();
  const [activeChannel, setActiveChannel] = useState<InboxChannel>('sms');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  // Channel counts
  const channelCounts = useMemo(() => ({
    sms: inbox.filter((m) => m.channel === 'sms').length,
    email: inbox.filter((m) => m.channel === 'email').length,
    form: inbox.filter((m) => m.channel === 'form').length,
  }), [inbox]);

  const unreadCounts = useMemo(() => ({
    sms: inbox.filter((m) => m.channel === 'sms' && !m.read).length,
    email: inbox.filter((m) => m.channel === 'email' && !m.read).length,
    form: inbox.filter((m) => m.channel === 'form' && !m.read).length,
  }), [inbox]);

  // Filter by channel + search
  const filtered = useMemo(() => {
    let list = inbox.filter((m) => m.channel === activeChannel);
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      list = list.filter((m) =>
        `${m.contactName || ''} ${m.fromNumber} ${m.fromAddress || ''} ${m.subject || ''} ${m.body}`.toLowerCase().includes(q)
      );
    }
    return list.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
  }, [inbox, activeChannel, searchTerm]);

  const selected = inbox.find((m) => m.messageId === selectedId);

  const handleSelect = (messageId: string) => {
    setSelectedId(messageId);
    markRead(messageId);
  };

  if (!hydrated) return null;

  const totalUnread = unreadCounts.sms + unreadCounts.email + unreadCounts.form;

  return (
    <>
      <PageHeader title="Inbox" subtitle={`${totalUnread} unread across all channels`} />

      {/* Channel tabs */}
      <div className="inbox-channel-tabs">
        {(Object.keys(CHANNEL_CONFIG) as InboxChannel[]).map((ch) => (
          <button
            key={ch}
            className={`inbox-channel-tab ${activeChannel === ch ? 'active' : ''}`}
            onClick={() => { setActiveChannel(ch); setSelectedId(null); setSearchTerm(''); }}
          >
            <span>{CHANNEL_CONFIG[ch].label}</span>
            <span className="inbox-channel-tab-count">{channelCounts[ch]}</span>
            {unreadCounts[ch] > 0 && <span className="inbox-channel-tab-unread">{unreadCounts[ch]}</span>}
          </button>
        ))}
      </div>

      <div className="inbox-layout">
        {/* Message list */}
        <div className="card p-0 overflow-hidden flex flex-col">
          <div className="p-4 border-b">
            <SearchInput value={searchTerm} onValueChange={setSearchTerm} placeholder={`Search ${CHANNEL_CONFIG[activeChannel].label.toLowerCase()}...`} className="search-full-width" />
          </div>
          <div className="flex-1 overflow-y-auto">
            {filtered.map((msg) => (
              <div
                key={msg.messageId}
                className={`inbox-message-item ${selectedId === msg.messageId ? 'selected' : ''}`}
                onClick={() => handleSelect(msg.messageId)}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className={`font-medium ${!msg.read ? 'text-primary' : 'text-secondary'}`} >
                    {msg.contactName || msg.fromAddress || msg.fromNumber || 'Unknown'}
                  </span>
                  <span className="text-tertiary" >
                    {new Date(msg.receivedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </span>
                </div>
                {/* Subject line for email */}
                {activeChannel === 'email' && msg.subject && (
                  <div className="text-primary" style={{ fontSize: 'var(--text-xs)', fontWeight: 500, marginBottom: 2 }}>
                    {msg.subject}
                  </div>
                )}
                {/* Form name for form submissions */}
                {activeChannel === 'form' && msg.formName && (
                  <div style={{ marginBottom: 2 }}>
                    <span className="badge badge-neutral" style={{ fontSize: '0.6rem' }}>{msg.formName}</span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  {!msg.read && <span className="inbox-unread-dot" />}
                  {msg.isKeyword && <span className="badge badge-danger" style={{ fontSize: '0.625rem' }}>KEYWORD</span>}
                  <span className="text-tertiary" style={{ fontSize: 'var(--text-xs)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{msg.body}</span>
                </div>
              </div>
            ))}
            {filtered.length === 0 && <EmptyState icon="—" title={searchTerm ? 'No matching messages' : `No ${CHANNEL_CONFIG[activeChannel].label.toLowerCase()} messages`} />}
          </div>
        </div>

        {/* Message detail */}
        <div className="card flex flex-col">
          {selected ? (
            <>
              <div className="pb-4 border-b mb-4">
                <h2 className="text-primary font-semibold text-lg mb-1">
                  {selected.contactName || 'Unknown Contact'}
                </h2>
                {selected.channel === 'sms' && (
                  <span className="font-mono text-tertiary" >{selected.fromNumber}</span>
                )}
                {selected.channel === 'email' && (
                  <span className="text-tertiary" >{selected.fromAddress}</span>
                )}
                {selected.channel === 'form' && selected.formName && (
                  <span className="badge badge-neutral">{selected.formName}</span>
                )}
                {selected.channel === 'email' && selected.subject && (
                  <div className="text-primary text-sm font-medium mt-2">
                    {selected.subject}
                  </div>
                )}
              </div>

              <div className="flex-1 flex flex-col justify-end">
                {/* Form submissions show field breakdown */}
                {selected.channel === 'form' && selected.formFields ? (
                  <div className="inbox-form-fields">
                    {selected.formFields.map((f, i) => (
                      <div key={i} className="inbox-form-field-row">
                        <span className="inbox-form-field-label">{f.label}</span>
                        <span className="inbox-form-field-value">{f.value}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="inbox-bubble">
                    <p className="text-primary text-sm">{selected.body}</p>
                    <span className="text-tertiary text-xs mt-1" style={{ display: 'block' }}>
                      {new Date(selected.receivedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </div>
                )}
              </div>

              {/* Reply bar — only for SMS and Email */}
              {(selected.channel === 'sms' || selected.channel === 'email') && (
                <div className="flex gap-3 pt-4 border-t">
                  <input type="text" className="form-input flex-1" placeholder={selected.channel === 'email' ? 'Type a reply...' : 'Type a reply...'} />
                  <Button variant="primary">Send</Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState icon="—" title="Select a conversation" description="Choose a message from the list to view details." />
          )}
        </div>
      </div>
    </>
  );
}
