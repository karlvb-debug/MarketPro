import { SQSEvent, SQSHandler } from "aws-lambda";
import {
  ConnectCampaignsClient,
  PutDialRequestBatchCommand,
} from "@aws-sdk/client-connectcampaigns";
import { eq, and } from "drizzle-orm";
import { getDb } from "../lib/db";
import {
  campaigns,
  callScripts,
  contacts,
  contactSegment,
  workspaceSettings,
  campaignMessages,
  suppressionList,
} from "../../drizzle/schema";
import * as crypto from "crypto";

const campaignsClient = new ConnectCampaignsClient({});
const CAMPAIGN_ID = process.env.CONNECT_CAMPAIGN_ID;

export const handler: SQSHandler = async (event: SQSEvent) => {
  const db = await getDb();

  for (const record of event.Records) {
    try {
      const payload = JSON.parse(record.body);
      const { campaignId, workspaceId } = payload;

      if (!campaignId || !workspaceId) {
        console.error("Invalid payload:", payload);
        continue;
      }

      console.log(
        `Processing Voice campaign ${campaignId} for workspace ${workspaceId}`,
      );

      // 1. Fetch Campaign
      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.campaignId, campaignId),
            eq(campaigns.workspaceId, workspaceId),
          ),
        );

      if (
        !campaign ||
        campaign.status === "completed" ||
        campaign.status === "cancelled"
      ) {
        console.log(`Campaign ${campaignId} not found or already processed.`);
        continue;
      }

      // 2. Fetch Call Script (Template)
      const [template] = await db
        .select()
        .from(callScripts)
        .where(
          and(
            eq(callScripts.scriptId, campaign.templateId),
            eq(callScripts.workspaceId, workspaceId),
          ),
        );

      if (!template) {
        console.error(`Call Script not found for campaign ${campaignId}`);
        continue;
      }

      // 3. Fetch Workspace Settings
      const [settings] = await db
        .select()
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, workspaceId));

      const sourcePhoneNumber = settings?.voicePhoneNumber;
      if (!sourcePhoneNumber) {
        console.error(
          `No Voice phone number configured for workspace ${workspaceId}`,
        );
        await db
          .update(campaigns)
          .set({ status: "cancelled" })
          .where(eq(campaigns.campaignId, campaignId));
        continue;
      }

      // 4. Fetch Segment Contacts
      const segmentContactsResult = await db
        .select({
          contact: contacts,
        })
        .from(contactSegment)
        .innerJoin(contacts, eq(contactSegment.contactId, contacts.contactId))
        .where(
          and(
            eq(contactSegment.segmentId, campaign.segmentId),
            eq(contacts.status, "active"),
          ),
        );

      // 4.5 Fetch Suppression List
      const suppressions = await db
        .select({ phoneHash: suppressionList.phoneHash })
        .from(suppressionList)
        .where(eq(suppressionList.workspaceId, workspaceId));

      const suppressedHashes = new Set(
        suppressions.map((s: any) => s.phoneHash).filter(Boolean),
      );

      // 5. Build Dial Requests
      const dialRequests = [];
      const contactMap = new Map<string, any>(); // Map clientToken to contact info

      for (const { contact } of segmentContactsResult) {
        if (!contact.phone) continue;

        const phoneNorm = contact.phone.replace(/\D/g, "");
        let phoneE164 = contact.phone.trim();
        if (!phoneE164.startsWith("+")) {
          const cleanDigits = phoneE164.replace(/\D/g, "");
          if (cleanDigits.length === 10) {
            phoneE164 = `+1${cleanDigits}`;
          } else {
            phoneE164 = `+${cleanDigits}`;
          }
        }

        const phoneHash = crypto
          .createHash("sha256")
          .update(phoneNorm)
          .digest("hex");
        if (suppressedHashes.has(phoneHash)) {
          console.log(
            `Phone ${contact.phone} is in suppression list, skipping voice call.`,
          );
          continue;
        }

        const clientToken = crypto.randomUUID();

        // 2 hours from now expiration time
        const expirationTime = new Date(Date.now() + 2 * 60 * 60 * 1000);

        dialRequests.push({
          clientToken,
          phoneNumber: phoneE164,
          expirationTime,
          attributes: {
            FirstName: contact.firstName || "",
            LastName: contact.lastName || "",
            Company: contact.company || "",
            VoiceId: template.voiceId || "Joanna",
            SSMLContent: template.ssmlContent || "<speak>Hello</speak>",
            VoicemailSSML:
              template.voicemailSsml ||
              template.ssmlContent ||
              "<speak>Hello</speak>",
            WorkspaceId: workspaceId.toString(),
          },
        });

        contactMap.set(clientToken, { contact, phoneNumber: phoneE164 });
      }

      let delivered = 0;
      const total = segmentContactsResult.length;

      // 6. Submit Dial Requests in chunks of 25 (PutDialRequestBatch max limit)
      const chunkSize = 25;
      for (let i = 0; i < dialRequests.length; i += chunkSize) {
        const chunk = dialRequests.slice(i, i + chunkSize);

        try {
          const response = await campaignsClient.send(
            new PutDialRequestBatchCommand({
              id: CAMPAIGN_ID,
              dialRequests: chunk,
            }),
          );

          const failedMap = new Map<string, string>();
          if (response.failedRequests) {
            for (const fail of response.failedRequests) {
              if (fail.clientToken && fail.failureCode) {
                failedMap.set(fail.clientToken, fail.failureCode);
              }
            }
          }

          // Log each request
          for (const req of chunk) {
            const mapped = contactMap.get(req.clientToken);
            if (!mapped) continue;

            const { contact } = mapped;
            const failureReason = failedMap.get(req.clientToken);

            if (failureReason) {
              console.error(
                `Failed to dispatch call to ${req.phoneNumber}: ${failureReason}`,
              );
              await db.insert(campaignMessages).values({
                campaignId,
                workspaceId,
                contactId: contact.contactId,
                channel: "voice",
                status: "failed",
                fromIdentity: sourcePhoneNumber,
                errorCode: failureReason.substring(0, 100),
              });
            } else {
              await db.insert(campaignMessages).values({
                campaignId,
                workspaceId,
                contactId: contact.contactId,
                channel: "voice",
                status: "queued",
                fromIdentity: sourcePhoneNumber,
                sentAt: new Date(),
                providerMessageId: req.clientToken,
              });
              delivered++;
            }
          }
        } catch (err: any) {
          console.error(`Failed to dispatch batch:`, err.message);
          for (const req of chunk) {
            const mapped = contactMap.get(req.clientToken);
            if (!mapped) continue;
            const { contact } = mapped;

            await db.insert(campaignMessages).values({
              campaignId,
              workspaceId,
              contactId: contact.contactId,
              channel: "voice",
              status: "failed",
              fromIdentity: sourcePhoneNumber,
              errorCode: err.message?.substring(0, 100),
            });
          }
        }
      }

      // 7. Complete Campaign Dispatch
      await db
        .update(campaigns)
        .set({
          status: "completed",
          completedAt: new Date(),
          totalRecipients: total,
        })
        .where(eq(campaigns.campaignId, campaignId));

      console.log(
        `Campaign ${campaignId} dispatch completed. Queued ${delivered}/${total} calls.`,
      );
    } catch (err) {
      console.error("Error processing Voice SQS record:", err);
    }
  }
};
