import { pgTable, uuid, varchar, timestamp, numeric, pgEnum, check, text, boolean, integer, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ============================================
// ENUMS
// ============================================

export const transactionTypeEnum = pgEnum('transaction_type', ['AUTHORIZATION', 'CAPTURE', 'REFUND', 'DEPOSIT']);
export const workspaceRoleEnum = pgEnum('workspace_role', ['owner', 'admin', 'editor', 'viewer']);
export const contactStatusEnum = pgEnum('contact_status', ['active', 'unsubscribed', 'bounced', 'complained']);
export const channelEnum = pgEnum('channel', ['email', 'sms', 'voice']);
export const campaignStatusEnum = pgEnum('campaign_status', ['draft', 'scheduled', 'sending', 'completed', 'paused', 'cancelled']);
export const messageStatusEnum = pgEnum('message_status', ['queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'failed', 'unsubscribed']);
export const consentTypeEnum = pgEnum('consent_type', ['opt_in', 'opt_out']);
export const suppressionReasonEnum = pgEnum('suppression_reason', ['unsubscribe', 'complaint', 'bounce', 'gdpr_delete', 'manual']);
export const consentSourceEnum = pgEnum('consent_source', ['collected_by_us', 'partner_with_proof', 'existing_customers', 'purchased_list', 'unknown']);
export const customFieldTypeEnum = pgEnum('custom_field_type', ['text', 'number', 'date', 'email', 'phone', 'url', 'select']);

// ============================================
// 1. WORKSPACES (existing)
// ============================================

export const workspaces = pgTable('workspaces', {
  workspaceId: uuid('workspace_id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ============================================
// 2. ACCOUNT BALANCES — Double-Entry Cache (existing)
// ============================================

export const accountBalances = pgTable('account_balances', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  availableCredits: numeric('available_credits', { precision: 15, scale: 6 }).default('0.000000'),
  holdCredits: numeric('hold_credits', { precision: 15, scale: 6 }).default('0.000000'),
  lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  // Drizzle allows defining postgres CHECK constraints native to the DB schema
  checkPositiveAvailable: check('account_balances_check_positive', sql`${table.availableCredits} >= 0`),
  checkPositiveHold: check('account_balances_hold_positive', sql`${table.holdCredits} >= 0`),
}));

// ============================================
// 3. TRANSACTIONS LEDGER — Immutable Log (existing)
// ============================================

export const transactionsLedger = pgTable('transactions_ledger', {
  transactionId: uuid('transaction_id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  type: transactionTypeEnum('type').notNull(),
  amount: numeric('amount', { precision: 15, scale: 6 }).notNull(),
  referenceId: varchar('reference_id', { length: 255 }), // e.g., Stripe Payment Intent ID or Campaign Dispatch ID
  status: varchar('status', { length: 50 }).default('COMPLETED'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ============================================
// 4. USERS & WORKSPACES — RBAC
// ============================================

export const usersWorkspaces = pgTable('users_workspaces', {
  userId: varchar('user_id', { length: 255 }).notNull(), // Cognito sub ID
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  role: workspaceRoleEnum('role').notNull().default('viewer'),
  invitedAt: timestamp('invited_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  // Composite primary key: one role per user per workspace
  pk: uniqueIndex('users_workspaces_pk').on(table.userId, table.workspaceId),
}));

// ============================================
// 5. CONTACTS
// ============================================

export const contacts = pgTable('contacts', {
  contactId: uuid('contact_id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  email: varchar('email', { length: 320 }),              // RFC 5321 max length
  phone: varchar('phone', { length: 20 }),                // E.164 format (+15551234567)
  firstName: varchar('first_name', { length: 100 }),
  lastName: varchar('last_name', { length: 100 }),
  company: varchar('company', { length: 255 }),
  timezone: varchar('timezone', { length: 50 }),          // e.g. 'America/New_York' — used by TCPA engine
  state: varchar('state', { length: 2 }),                  // US state / province code — used for state-specific compliance rules
  status: contactStatusEnum('status').notNull().default('active'),
  source: varchar('source', { length: 50 }),              // 'csv_import', 'api', 'manual'
  consentSource: consentSourceEnum('consent_source'),     // How consent was obtained
  customFields: jsonb('custom_fields').default({}),       // Flexible key-value for merge tags
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  // Prevent duplicate contacts within a workspace
  uniqueEmail: uniqueIndex('contacts_unique_email').on(table.workspaceId, table.email),
  uniquePhone: uniqueIndex('contacts_unique_phone').on(table.workspaceId, table.phone),
  // Fast lookup by workspace
  workspaceIdx: index('contacts_workspace_idx').on(table.workspaceId),
  // Fast lookup by status within workspace (for segmentation queries)
  statusIdx: index('contacts_status_idx').on(table.workspaceId, table.status),
}));

// ============================================
// 6. SEGMENTS
// ============================================

export const segments = pgTable('segments', {
  segmentId: uuid('segment_id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  folderId: uuid('folder_id'),                             // FK to segment_folders
  sortOrder: integer('sort_order').default(0),
  color: varchar('color', { length: 20 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  workspaceIdx: index('segments_workspace_idx').on(table.workspaceId),
}));

// ============================================
// 7. CONTACT ↔ SEGMENT (Many-to-Many)
// ============================================

export const contactSegment = pgTable('contact_segment', {
  contactId: uuid('contact_id')
    .notNull()
    .references(() => contacts.contactId, { onDelete: 'cascade' }),
  segmentId: uuid('segment_id')
    .notNull()
    .references(() => segments.segmentId, { onDelete: 'cascade' }),
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  pk: uniqueIndex('contact_segment_pk').on(table.contactId, table.segmentId),
  // Fast lookup: "give me all contacts in segment X"
  segmentIdx: index('contact_segment_segment_idx').on(table.segmentId),
}));

// ============================================
// 8. EMAIL TEMPLATES
// ============================================

export const emailTemplates = pgTable('email_templates', {
  templateId: uuid('template_id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  subjectLine: varchar('subject_line', { length: 998 }),  // RFC 2822 max subject length
  fromName: varchar('from_name', { length: 255 }),
  replyTo: varchar('reply_to', { length: 320 }),
  htmlContent: text('html_content'),
  editorJson: jsonb('editor_json'),                       // Block editor design JSON
  thumbnailUrl: varchar('thumbnail_url', { length: 2048 }),
  folderId: uuid('folder_id'),                            // FK to template_folders
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  workspaceIdx: index('email_templates_workspace_idx').on(table.workspaceId),
}));

// ============================================
// 9. SMS TEMPLATES
// ============================================

export const smsTemplates = pgTable('sms_templates', {
  templateId: uuid('template_id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  body: text('body').notNull(),
  isUnicode: boolean('is_unicode').default(false),
  estimatedSegments: integer('estimated_segments').default(1),
  folderId: uuid('folder_id'),                            // FK to template_folders
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  workspaceIdx: index('sms_templates_workspace_idx').on(table.workspaceId),
}));

// ============================================
// 10. CALL SCRIPTS
// ============================================

export const callScripts = pgTable('call_scripts', {
  scriptId: uuid('script_id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  ssmlContent: text('ssml_content'),
  voicemailSsml: text('voicemail_ssml'),
  voiceId: varchar('voice_id', { length: 50 }).default('Joanna'),
  connectFlowJson: jsonb('connect_flow_json'),
  folderId: uuid('folder_id'),                            // FK to template_folders
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  workspaceIdx: index('call_scripts_workspace_idx').on(table.workspaceId),
}));

// ============================================
// 11. CAMPAIGNS
// ============================================

export const campaigns = pgTable('campaigns', {
  campaignId: uuid('campaign_id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  channel: channelEnum('channel').notNull(),
  templateId: uuid('template_id').notNull(),              // FK to email_templates, sms_templates, or call_scripts based on channel
  segmentId: uuid('segment_id')
    .notNull()
    .references(() => segments.segmentId),
  status: campaignStatusEnum('status').notNull().default('draft'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }), // null = send immediately
  completedAt: timestamp('completed_at', { withTimezone: true }),
  totalRecipients: integer('total_recipients'),
  estimatedCost: numeric('estimated_cost', { precision: 15, scale: 6 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  workspaceIdx: index('campaigns_workspace_idx').on(table.workspaceId),
  statusIdx: index('campaigns_status_idx').on(table.workspaceId, table.status),
  scheduledIdx: index('campaigns_scheduled_idx').on(table.scheduledAt),
}));

// ============================================
// 12. CAMPAIGN MESSAGES — Send History & Results
// ============================================

export const campaignMessages = pgTable('campaign_messages', {
  messageId: uuid('message_id').defaultRandom().primaryKey(), // Also serves as idempotency key
  campaignId: uuid('campaign_id')
    .notNull()
    .references(() => campaigns.campaignId, { onDelete: 'cascade' }),
  contactId: uuid('contact_id')
    .references(() => contacts.contactId, { onDelete: 'set null' }), // Nullable: GDPR deletion anonymizes but preserves aggregate stats
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId),              // Denormalized for fast workspace-level queries
  channel: channelEnum('channel').notNull(),
  status: messageStatusEnum('status').notNull().default('queued'),
  fromIdentity: varchar('from_identity', { length: 320 }), // Sending phone/email/queue used (compliance audit)
  sentAt: timestamp('sent_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  clickedAt: timestamp('clicked_at', { withTimezone: true }),
  providerMessageId: varchar('provider_message_id', { length: 255 }), // SES/SMS/Connect reference
  errorCode: varchar('error_code', { length: 100 }),
  cost: numeric('cost', { precision: 15, scale: 6 }),
}, (table) => ({
  campaignIdx: index('campaign_messages_campaign_idx').on(table.campaignId),
  contactIdx: index('campaign_messages_contact_idx').on(table.contactId),
  workspaceIdx: index('campaign_messages_workspace_idx').on(table.workspaceId),
  statusIdx: index('campaign_messages_status_idx').on(table.campaignId, table.status),
}));

// ============================================
// 13. SMS INBOX — Inbound Messages
// ============================================

export const smsInbox = pgTable('sms_inbox', {
  messageId: uuid('message_id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  contactId: uuid('contact_id')
    .references(() => contacts.contactId),                  // Null if sender is unknown
  fromNumber: varchar('from_number', { length: 20 }).notNull(),
  toNumber: varchar('to_number', { length: 20 }).notNull(), // The workspace's number
  body: text('body'),
  isKeyword: boolean('is_keyword').default(false),          // Auto-handled keyword (STOP, HELP)
  keywordType: varchar('keyword_type', { length: 20 }),     // 'STOP', 'HELP', 'START', or null
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),     // Null = unread
}, (table) => ({
  workspaceIdx: index('sms_inbox_workspace_idx').on(table.workspaceId),
  contactIdx: index('sms_inbox_contact_idx').on(table.contactId),
  // For "show me unread messages" queries
  unreadIdx: index('sms_inbox_unread_idx').on(table.workspaceId, table.readAt),
}));

// ============================================
// 14. CONSENT LEDGER — Immutable TCPA Compliance
// ============================================

export const consentLedger = pgTable('consent_ledger', {
  consentId: uuid('consent_id').defaultRandom().primaryKey(),
  contactId: uuid('contact_id')
    .references(() => contacts.contactId, { onDelete: 'set null' }), // Nullable: RTF Lambda hashes PII before contact deletion
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId),
  channel: channelEnum('channel').notNull(),
  consentType: consentTypeEnum('consent_type').notNull(),   // opt_in or opt_out
  source: varchar('source', { length: 100 }),               // 'web_form', 'csv_import', 'keyword_reply', 'manual'
  disclosureText: text('disclosure_text'),                  // Exact legal text shown at time of consent
  ipAddress: varchar('ip_address', { length: 45 }),         // IPv4 or IPv6
  evidenceUrl: varchar('evidence_url', { length: 2048 }),   // Screenshot or recording URL
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(), // Immutable — never updated
}, (table) => ({
  contactIdx: index('consent_ledger_contact_idx').on(table.contactId),
  workspaceIdx: index('consent_ledger_workspace_idx').on(table.workspaceId),
}));

// ============================================
// 15. SUPPRESSION LIST — Hashed PII
// ============================================

export const suppressionList = pgTable('suppression_list', {
  suppressionId: uuid('suppression_id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  phoneHash: varchar('phone_hash', { length: 64 }),        // SHA-256 hex digest
  emailHash: varchar('email_hash', { length: 64 }),        // SHA-256 hex digest
  reason: suppressionReasonEnum('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  // Fast lookup during pre-send checks: "is this phone/email suppressed?"
  phoneHashIdx: index('suppression_phone_hash_idx').on(table.workspaceId, table.phoneHash),
  emailHashIdx: index('suppression_email_hash_idx').on(table.workspaceId, table.emailHash),
}));

// ============================================
// 16. WORKSPACE SETTINGS — Channel Config & Compliance
// ============================================

export const workspaceSettings = pgTable('workspace_settings', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  // Channel configuration
  smsSenderId: varchar('sms_sender_id', { length: 50 }),
  smsPhoneNumber: varchar('sms_phone_number', { length: 20 }),
  voicePhoneNumber: varchar('voice_phone_number', { length: 20 }),
  emailFromName: varchar('email_from_name', { length: 255 }),
  emailFromAddress: varchar('email_from_address', { length: 320 }),
  emailReplyTo: varchar('email_reply_to', { length: 320 }),
  timezone: varchar('timezone', { length: 50 }).default('America/New_York'),
  // Compliance — CAN-SPAM
  businessName: varchar('business_name', { length: 255 }),
  businessAddress: text('business_address'),
  businessCity: varchar('business_city', { length: 100 }),
  businessState: varchar('business_state', { length: 50 }),
  businessZip: varchar('business_zip', { length: 20 }),
  businessCountry: varchar('business_country', { length: 10 }).default('US'),
  // Compliance — DNC
  lastDncScrubDate: timestamp('last_dnc_scrub_date', { withTimezone: true }),
  sanNumber: varchar('san_number', { length: 50 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// ============================================
// 17. SEGMENT FOLDERS
// ============================================

export const segmentFolders = pgTable('segment_folders', {
  folderId: uuid('folder_id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  workspaceIdx: index('segment_folders_workspace_idx').on(table.workspaceId),
}));

// ============================================
// 18. TEMPLATE FOLDERS
// ============================================

export const templateFolders = pgTable('template_folders', {
  folderId: uuid('folder_id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  workspaceIdx: index('template_folders_workspace_idx').on(table.workspaceId),
}));

// ============================================
// 19. WEB FORMS
// ============================================

export const webForms = pgTable('web_forms', {
  formId: uuid('form_id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  fields: jsonb('fields').default([]),                      // WebFormField[] definition
  submitLabel: varchar('submit_label', { length: 100 }).default('Submit'),
  successMessage: text('success_message').default('Thank you!'),
  design: jsonb('design'),                                  // Block editor design JSON
  folderId: uuid('folder_id'),                              // FK to template_folders
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  workspaceIdx: index('web_forms_workspace_idx').on(table.workspaceId),
}));

// ============================================
// 20. CUSTOM FIELD DEFINITIONS — Workspace-level
// ============================================

export const customFieldDefinitions = pgTable('custom_field_definitions', {
  fieldId: uuid('field_id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  key: varchar('key', { length: 100 }).notNull(),
  type: customFieldTypeEnum('type').notNull().default('text'),
  isUnique: boolean('is_unique').default(false),
  required: boolean('required').default(false),
  options: jsonb('options'),                                // For 'select' type: string[]
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  workspaceIdx: index('custom_field_defs_workspace_idx').on(table.workspaceId),
  uniqueKey: uniqueIndex('custom_field_defs_unique_key').on(table.workspaceId, table.key),
}));

// ============================================
// 21. EMAIL INBOX — Inbound Emails
// ============================================

export const emailInbox = pgTable('email_inbox', {
  messageId: uuid('message_id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  contactId: uuid('contact_id')
    .references(() => contacts.contactId),
  fromAddress: varchar('from_address', { length: 320 }).notNull(),
  subject: varchar('subject', { length: 998 }),
  body: text('body'),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
}, (table) => ({
  workspaceIdx: index('email_inbox_workspace_idx').on(table.workspaceId),
  contactIdx: index('email_inbox_contact_idx').on(table.contactId),
  unreadIdx: index('email_inbox_unread_idx').on(table.workspaceId, table.readAt),
}));

// ============================================
// 22. FORM SUBMISSIONS
// ============================================

export const formSubmissions = pgTable('form_submissions', {
  submissionId: uuid('submission_id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  formId: uuid('form_id')
    .notNull()
    .references(() => webForms.formId, { onDelete: 'cascade' }),
  contactId: uuid('contact_id')
    .references(() => contacts.contactId),
  formData: jsonb('form_data').notNull(),                   // { fieldName: value } pairs
  ipAddress: varchar('ip_address', { length: 45 }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
}, (table) => ({
  workspaceIdx: index('form_submissions_workspace_idx').on(table.workspaceId),
  formIdx: index('form_submissions_form_idx').on(table.formId),
  contactIdx: index('form_submissions_contact_idx').on(table.contactId),
}));

