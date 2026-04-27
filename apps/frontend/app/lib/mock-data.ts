// Mock data for local development — will be replaced with API calls when backend is connected

export const mockContacts = [
  { contactId: '1', firstName: 'Sarah', lastName: 'Chen', email: 'sarah.chen@acmecorp.com', phone: '+15551234567', company: 'Acme Corp', status: 'active' as const, segments: ['VIP Customers', 'Newsletter'], source: 'csv_import' },
  { contactId: '2', firstName: 'Marcus', lastName: 'Rodriguez', email: 'marcus.r@techwave.io', phone: '+15559876543', company: 'TechWave', status: 'active' as const, segments: ['Newsletter'], source: 'api',
    compliance: {
      sms: { suppressed: true, reason: 'stop' as const, updatedAt: '2026-04-20T14:30:00Z' },
    },
  },
  { contactId: '3', firstName: 'Emily', lastName: 'Nakamura', email: 'enakamura@bluesky.co', phone: '+15555551234', company: 'BlueSky Inc', status: 'active' as const, segments: ['VIP Customers', 'Product Updates'], source: 'manual' },
  { contactId: '4', firstName: 'James', lastName: 'Thompson', email: 'j.thompson@redfin.com', phone: '+15553334444', company: 'Redfin Group', status: 'unsubscribed' as const, segments: [], source: 'csv_import' },
  { contactId: '5', firstName: 'Aisha', lastName: 'Patel', email: 'aisha.p@sunrisemed.org', phone: '+15552228888', company: 'Sunrise Medical', status: 'active' as const, segments: ['Newsletter', 'Product Updates'], source: 'csv_import',
    compliance: {
      email: { suppressed: true, reason: 'complained' as const, updatedAt: '2026-04-18T09:15:00Z' },
      sms: { suppressed: true, reason: 'stop' as const, updatedAt: '2026-04-19T11:00:00Z' },
    },
  },
  { contactId: '6', firstName: 'David', lastName: 'Kim', email: 'dkim@velocity.tech', phone: '+15557776666', company: 'Velocity Tech', status: 'bounced' as const, segments: ['Product Updates'], source: 'api' },
  { contactId: '7', firstName: 'Lauren', lastName: 'Brooks', email: 'lbrooks@greenfield.co', phone: '+15551119999', company: 'Greenfield Co', status: 'active' as const, segments: ['VIP Customers'], source: 'manual',
    compliance: {
      email: { suppressed: true, reason: 'dnc' as const, updatedAt: '2026-04-10T08:00:00Z' },
      sms: { suppressed: true, reason: 'dnc' as const, updatedAt: '2026-04-10T08:00:00Z' },
      voice: { suppressed: true, reason: 'dnc' as const, updatedAt: '2026-04-10T08:00:00Z' },
    },
  },
  { contactId: '8', firstName: 'Carlos', lastName: 'Gutierrez', email: 'carlos@brightpath.io', phone: '+15554443333', company: 'BrightPath', status: 'active' as const, segments: ['Newsletter'], source: 'csv_import' },
];

export const mockSegments = [
  { segmentId: '1', name: 'VIP Customers', count: 3, description: 'High-value customers with repeat purchases' },
  { segmentId: '2', name: 'Newsletter', count: 5, description: 'Opted in to weekly newsletter' },
  { segmentId: '3', name: 'Product Updates', count: 3, description: 'Interested in product announcements' },
];

export const mockCampaigns = [
  { campaignId: '1', name: 'Spring Sale Announcement', channel: 'email' as const, status: 'completed' as const, segment: 'Newsletter', scheduledAt: '2026-04-15T10:00:00Z', totalRecipients: 4850, delivered: 4721, opened: 2103, clicked: 847, bounced: 129 },
  { campaignId: '2', name: 'Appointment Reminder', channel: 'sms' as const, status: 'completed' as const, segment: 'VIP Customers', scheduledAt: '2026-04-18T14:00:00Z', totalRecipients: 1200, delivered: 1183, opened: null, clicked: 392, bounced: 17 },
  { campaignId: '3', name: 'Product Launch Blast', channel: 'email' as const, status: 'scheduled' as const, segment: 'Product Updates', scheduledAt: '2026-04-25T09:00:00Z', totalRecipients: 3200, delivered: 0, opened: 0, clicked: 0, bounced: 0 },
  { campaignId: '4', name: 'Flash Sale Alert', channel: 'sms' as const, status: 'draft' as const, segment: 'VIP Customers', scheduledAt: null, totalRecipients: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0 },
  { campaignId: '5', name: 'Payment Reminder Calls', channel: 'voice' as const, status: 'sending' as const, segment: 'VIP Customers', scheduledAt: '2026-04-23T11:00:00Z', totalRecipients: 450, delivered: 312, opened: null, clicked: null, bounced: 23 },
];

export const mockTemplates = {
  email: [
    { templateId: '1', name: 'Spring Sale Promo', subjectLine: 'Don\'t Miss Our Biggest Sale!', updatedAt: '2026-04-12T15:30:00Z' },
    { templateId: '2', name: 'Welcome Series — Day 1', subjectLine: 'Welcome to {{company_name}}!', updatedAt: '2026-04-08T09:00:00Z' },
    { templateId: '3', name: 'Monthly Newsletter', subjectLine: 'Your April Roundup from {{company_name}}', updatedAt: '2026-04-01T12:00:00Z' },
  ],
  sms: [
    { templateId: '4', name: 'Appointment Reminder', body: 'Hi {{first_name}}, reminder: your appointment is tomorrow at {{time}}. Reply STOP to opt out.', estimatedSegments: 1 },
    { templateId: '5', name: 'Flash Sale Alert', body: '🔥 FLASH SALE! 40% off everything for the next 24 hours. Shop now: {{link}} Reply STOP to opt out.', estimatedSegments: 2 },
  ],
  voice: [
    { scriptId: '1', name: 'Payment Reminder Call', voiceId: 'Joanna', updatedAt: '2026-04-10T14:00:00Z' },
  ],
};

export const mockInbox = [
  // SMS
  { messageId: '1', channel: 'sms' as const, fromNumber: '+15551234567', contactName: 'Sarah Chen', body: 'Thanks for the reminder! I\'ll be there.', receivedAt: '2026-04-23T14:32:00Z', read: true },
  { messageId: '2', channel: 'sms' as const, fromNumber: '+15559876543', contactName: 'Marcus Rodriguez', body: 'Can I reschedule to Friday?', receivedAt: '2026-04-23T15:10:00Z', read: false },
  { messageId: '3', channel: 'sms' as const, fromNumber: '+15555551234', contactName: 'Emily Nakamura', body: 'What time does the sale end?', receivedAt: '2026-04-23T16:45:00Z', read: false },
  { messageId: '4', channel: 'sms' as const, fromNumber: '+15552228888', contactName: 'Aisha Patel', body: 'STOP', receivedAt: '2026-04-23T17:20:00Z', read: true, isKeyword: true },
  { messageId: '5', channel: 'sms' as const, fromNumber: '+15557776666', contactName: null, body: 'Who is this?', receivedAt: '2026-04-23T18:05:00Z', read: false },
  // Email
  { messageId: '6', channel: 'email' as const, fromNumber: '', fromAddress: 'sarah.chen@acmecorp.com', contactName: 'Sarah Chen', subject: 'Re: Spring Sale Announcement', body: 'Love the new collection! When will the summer line drop?', receivedAt: '2026-04-23T10:15:00Z', read: true },
  { messageId: '7', channel: 'email' as const, fromNumber: '', fromAddress: 'carlos@brightpath.io', contactName: 'Carlos Gutierrez', subject: 'Unsubscribe request', body: 'Please remove me from your mailing list. Thank you.', receivedAt: '2026-04-23T11:42:00Z', read: false },
  { messageId: '8', channel: 'email' as const, fromNumber: '', fromAddress: 'enakamura@bluesky.co', contactName: 'Emily Nakamura', subject: 'Re: Monthly Newsletter', body: 'Great content this month! Could you share more about the product roadmap?', receivedAt: '2026-04-23T14:08:00Z', read: false },
  // Form submissions
  { messageId: '9', channel: 'form' as const, fromNumber: '', contactName: 'Alex Rivera', body: 'Interested in enterprise pricing for 500+ seats.', formName: 'Contact Us', formFields: [{ label: 'Name', value: 'Alex Rivera' }, { label: 'Email', value: 'alex@startupco.com' }, { label: 'Message', value: 'Interested in enterprise pricing for 500+ seats.' }], receivedAt: '2026-04-23T09:30:00Z', read: false },
  { messageId: '10', channel: 'form' as const, fromNumber: '', contactName: 'Jordan Lee', body: 'Bug report: checkout page throws 500 error on Safari.', formName: 'Support Request', formFields: [{ label: 'Name', value: 'Jordan Lee' }, { label: 'Email', value: 'jlee@devshop.io' }, { label: 'Issue', value: 'Bug report: checkout page throws 500 error on Safari.' }], receivedAt: '2026-04-23T12:55:00Z', read: true },
];

export const mockDashboardStats = {
  totalContacts: 8420,
  contactsChange: '+12.5%',
  activeCampaigns: 3,
  campaignsChange: '+2',
  messagesSent: 28750,
  messagesChange: '+18.3%',
  unreadInbox: 3,
  inboxChange: '+3',
};
