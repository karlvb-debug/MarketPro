import { Logger } from '../../lib/logger';

/** The contact fields dispatch needs (subset of the contacts table row). */
export interface DispatchContact {
  contactId: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
}

export interface DispatchCampaign {
  campaignId: string;
  workspaceId: string;
  templateId: string;
  segmentId: string;
  status: string;
}

export interface WorkspaceDispatchSettings {
  emailFromAddress: string | null;
  emailFromName: string | null;
  emailReplyTo: string | null;
  smsPhoneNumber: string | null;
  voicePhoneNumber: string | null;
}

/** A recipient successfully claimed for this invocation (newly inserted row). */
export interface ClaimedRecipient {
  messageId: string;
  contact: DispatchContact;
}

export type SendResult =
  | { contactId: string; ok: true; providerMessageId: string | null }
  | { contactId: string; ok: false; errorCode: string };

/**
 * Channel-specific behavior. Adapters must throw RetryableDispatchError (or
 * any error matching isRetryableError) for systemic failures, and report
 * per-recipient failures via SendResult instead of throwing.
 */
export interface ChannelAdapter<TTemplate, TSetup> {
  channel: 'email' | 'sms' | 'voice';

  fetchTemplate(templateId: string, workspaceId: string): Promise<TTemplate | undefined>;

  /**
   * Validate settings and precompute send configuration.
   * Returning { configError } cancels the campaign (non-retryable setup problem).
   */
  prepare(
    campaign: DispatchCampaign,
    template: TTemplate,
    settings: WorkspaceDispatchSettings | undefined,
  ): { setup: TSetup; fromIdentity: string } | { configError: string };

  /** The recipient field this channel sends to; contacts without it are skipped. */
  recipientOf(contact: DispatchContact): string | null;

  /** sha256 hash used against the suppression list for this channel. */
  suppressionHashOf(contact: DispatchContact): string;

  /** Which suppression hash column applies: 'email' or 'phone'. */
  suppressionHashKind: 'email' | 'phone';

  /**
   * Send to one page of claimed recipients. Must return one SendResult per
   * claimed recipient. Throws only for systemic (retryable) failures.
   */
  sendBatch(claimed: ClaimedRecipient[], setup: TSetup, logger: Logger): Promise<SendResult[]>;
}

/** Persistence operations, injected so the engine is unit-testable. */
export interface DispatchStore {
  fetchCampaign(campaignId: string, workspaceId: string): Promise<DispatchCampaign | undefined>;
  fetchSettings(workspaceId: string): Promise<WorkspaceDispatchSettings | undefined>;
  cancelCampaign(campaignId: string, reason: string): Promise<void>;

  /** Keyset page of active segment contacts with contactId > afterContactId. */
  fetchContactsPage(
    segmentId: string,
    afterContactId: string | null,
    limit: number,
  ): Promise<DispatchContact[]>;

  /** Subset of the given hashes present on the workspace suppression list. */
  fetchSuppressedHashes(
    workspaceId: string,
    kind: 'email' | 'phone',
    hashes: string[],
  ): Promise<Set<string>>;

  /**
   * Insert 'queued' claim rows for the given contacts with
   * ON CONFLICT (campaign_id, contact_id) DO NOTHING.
   * Returns only the recipients actually claimed by THIS call.
   */
  claimRecipients(
    campaign: DispatchCampaign,
    channel: 'email' | 'sms' | 'voice',
    fromIdentity: string,
    contacts: DispatchContact[],
  ): Promise<ClaimedRecipient[]>;

  markSent(messageId: string, providerMessageId: string | null): Promise<void>;
  markFailed(messageId: string, errorCode: string): Promise<void>;

  /** Marks the campaign completed (guarded) with the true recipient count. */
  completeCampaign(campaignId: string): Promise<number>;
}
