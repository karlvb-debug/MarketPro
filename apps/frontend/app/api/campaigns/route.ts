import { createCampaign, listCampaigns } from '@repo/core/api/campaigns';
import { readBody, withContext } from '../_lib/route';

export async function GET(req: Request) {
  return withContext(req, listCampaigns);
}

export async function POST(req: Request) {
  const body = await readBody(req);
  // No enqueue wired yet: campaigns are created, but dispatch still runs on the
  // legacy queue until M4 replaces it with pg-boss. Passing no `enqueue` is the
  // same path the Lambda took when a channel had no queue configured.
  return withContext(req, (ctx) => createCampaign(ctx, body));
}
