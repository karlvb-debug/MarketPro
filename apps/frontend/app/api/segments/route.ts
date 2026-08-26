import { createSegment, listSegments } from '@repo/core/api/segments';
import { readBody, withContext } from '../_lib/route';

export async function GET(req: Request) {
  return withContext(req, listSegments);
}

export async function POST(req: Request) {
  const body = await readBody(req);
  return withContext(req, (ctx) => createSegment(ctx, body));
}
