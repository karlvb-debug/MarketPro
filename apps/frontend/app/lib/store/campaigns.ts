'use client';

// ============================================
// Campaigns domain slice.
// ============================================

import { useCallback } from 'react';
import { api } from '../api-client';
import type { ApiCallFn, Campaign, SetStoreData } from './types';

interface CampaignsSliceDeps {
  setData: SetStoreData;
  apiCall: ApiCallFn;
}

export function useCampaignsSlice({ setData, apiCall }: CampaignsSliceDeps) {
  const addCampaign = useCallback((campaign: {
    name: string;
    channel: 'email' | 'sms' | 'voice';
    segment: string;
    templateId?: string;
    templateName?: string;
    scheduledAt: string | null;
  }) => {
    setData((prev) => {
      // Find segment to get recipient count
      const seg = prev.segments.find((s) => s.name === campaign.segment);
      const newCampaign: Campaign = {
        campaignId: crypto.randomUUID(),
        name: campaign.name,
        channel: campaign.channel,
        status: campaign.scheduledAt ? 'scheduled' : 'draft',
        segment: campaign.segment,
        templateId: campaign.templateId,
        templateName: campaign.templateName,
        scheduledAt: campaign.scheduledAt,
        totalRecipients: seg?.count || 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
        createdAt: new Date().toISOString(),
      };
      return { ...prev, campaigns: [newCampaign, ...prev.campaigns] };
    });
    // API: create campaign
    apiCall(() => api.campaigns.create({
      name: campaign.name,
      channel: campaign.channel,
      segment_id: campaign.segment,
      template_id: campaign.templateId,
      scheduled_at: campaign.scheduledAt,
    }));
  }, [apiCall, setData]);

  return { addCampaign };
}
