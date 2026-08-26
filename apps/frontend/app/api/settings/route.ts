import { getSettings, updateSettings } from '@repo/core/api/settings';
import { readBody, withContext } from '../_lib/route';

export async function GET(req: Request) {
  return withContext(req, getSettings);
}

export async function PUT(req: Request) {
  const body = await readBody(req);
  return withContext(req, (ctx) => updateSettings(ctx, body));
}
