import { createView, listViews } from '@repo/core/api/views';
import { readBody, withContext } from '../_lib/route';

export async function GET(req: Request) {
  return withContext(req, listViews);
}

export async function POST(req: Request) {
  const body = await readBody(req);
  return withContext(req, (ctx) => createView(ctx, body));
}
