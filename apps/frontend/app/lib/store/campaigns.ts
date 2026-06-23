'use client';

// ============================================
// Campaigns domain slice.
// ============================================

import { useCallback } from 'react';
import { api, ApiError } from '../api-client';
import { showToast } from '../../components/ui/Toast';
import type { Campaign, SetStoreData } from './types';

export type CampaignCreateResult =
  | { ok: true }
  | { ok: false; reason: 'insufficient_funds'; required: number; available: number; recipients: number }
  | { ok: false; reason: 'error'; message: string };

interface CampaignsSliceDeps {
  setData: SetStoreData;
}

export function useCampaignsSlice({ setData }: CampaignsSliceDeps) {
  const addCampaign = useCallback(async (campaign: {
    name: string;
    channel: 'email' | 'sms' | 'voice';
    segment: string;       // display name — for local store
    segmentId: string;     // UUID — for API
    recipientCount: number;
    templateId?: string;
    scheduledAt: string | null;
  }): Promise<CampaignCreateResult> => {
    const tempId = crypto.randomUUID();

    setData((prev) => ({
      ...prev,
      campaigns: [{
        campaignId: tempId,
        name: campaign.name,
        channel: campaign.channel,
        status: campaign.scheduledAt ? 'scheduled' : 'draft',
        segment: campaign.segment,
        templateId: campaign.templateId,
        scheduledAt: campaign.scheduledAt,
        totalRecipients: campaign.recipientCount,
        delivered: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
        createdAt: new Date().toISOString(),
      } as Campaign, ...prev.campaigns],
    }));

    try {
      const row = await api.campaigns.create({
        name: campaign.name,
        channel: campaign.channel,
        segment_id: campaign.segmentId,
        template_id: campaign.templateId,
        scheduled_at: campaign.scheduledAt,
      }) as { campaignId?: string; campaign_id?: string; status?: string };

      const realId = row.campaignId || row.campaign_id || tempId;
      setData((prev) => ({
        ...prev,
        campaigns: prev.campaigns.map((c) =>
          c.campaignId === tempId
            ? { ...c, campaignId: realId, status: (row.status as Campaign['status']) || c.status }
            : c
        ),
      }));
      return { ok: true };
    } catch (err) {
      const apiErr = err as ApiError;

      // Roll back optimistic insert
      setData((prev) => ({
        ...prev,
        campaigns: prev.campaigns.filter((c) => c.campaignId !== tempId),
      }));

      if (apiErr.status === 402) {
        return {
          ok: false,
          reason: 'insufficient_funds',
          required: apiErr.required ?? 0,
          available: apiErr.available ?? 0,
          recipients: apiErr.recipients ?? 0,
        };
      }

      showToast(apiErr.message || 'Failed to create campaign.', 'error');
      return { ok: false, reason: 'error', message: apiErr.message || 'Failed to create campaign.' };
    }
  }, [setData]);

  return { addCampaign };
}
