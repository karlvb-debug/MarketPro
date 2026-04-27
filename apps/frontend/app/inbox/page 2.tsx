'use client';

import { useState } from 'react';
import { useStore } from '../lib/store';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import { SearchInput } from '../components/Tabs';

export default function InboxPage() {
  const { inbox, markRead, hydrated } = useStore();
  const [selectedId, setSelectedId] = useState<string | null>(inbox[1]?.messageId || null);
  const [searchTerm, setSearchTerm] = useState('');

  const filtered = inbox.filter((m) =>
    `${m.contactName || ''} ${m.fromNumber} ${m.body}`.toLowerCase().includes(searchTerm.toLowerCase())
  );
  const selected = inbox.find((m) => m.messageId === selectedId);

  const handleSelect = (messageId: string) => {
    setSelectedId(messageId);
    markRead(messageId);
  };

  if (!hydrated) return null;

  return (
    <>
      <PageHeader title="SMS Inbox" subtitle={`${inbox.filter(m => !m.read).length} unread messages`} />

      <div className="inbox-layout">
        {/* Message list */}
        <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 'var(--space-4)', borderBottom: '1px solid var(--border-primary)' }}>
            <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search messages..." fullWidth />
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filtered.map((msg) => (
              <div key={msg.messageId} className={`inbox-message-item ${selectedId === msg.messageId ? 'selected' : ''}`} onClick={() => handleSelect(msg.messageId)}>
                <div className="flex items-center justify-between" style={{ marginBottom: 'var(--space-1)' }}>
                  <span className={`font-medium ${!msg.read ? 'text-primary' : 'text-secondary'}`} style={{ fontSize: 'var(--text-sm)' }}>
                    {msg.contactName || msg.fromNumber}
                  </span>
                  <span className="text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>
                    {new Date(msg.receivedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {!msg.read && <span className="inbox-unread-dot" />}
                  {msg.isKeyword && <span className="badge badge-danger" style={{ fontSize: '0.625rem' }}>KEYWORD</span>}
                  <span className="text-tertiary" style={{ fontSize: 'var(--text-xs)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{msg.body}</span>
                </div>
              </div>
            ))}
            {filtered.length === 0 && <EmptyState icon="💬" title="No messages" />}
          </div>
        </div>

        {/* Message detail */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          {selected ? (
            <>
              <div style={{ paddingBottom: 'var(--space-4)', borderBottom: '1px solid var(--border-primary)', marginBottom: 'var(--space-4)' }}>
                <h2 className="text-primary font-semibold" style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-1)' }}>
                  {selected.contactName || 'Unknown Contact'}
                </h2>
                <span className="font-mono text-tertiary" style={{ fontSize: 'var(--text-sm)' }}>{selected.fromNumber}</span>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                <div className="inbox-bubble">
                  <p className="text-primary" style={{ fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>{selected.body}</p>
                  <span className="text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 'var(--space-1)', display: 'block' }}>
                    {new Date(selected.receivedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-3)', paddingTop: 'var(--space-4)', borderTop: '1px solid var(--border-primary)' }}>
                <input type="text" className="form-input" placeholder="Type a reply..." style={{ flex: 1 }} />
                <button className="btn btn-primary">Send</button>
              </div>
            </>
          ) : (
            <EmptyState icon="💬" title="Select a conversation" description="Choose a message from the list to view the conversation." />
          )}
        </div>
      </div>
    </>
  );
}
