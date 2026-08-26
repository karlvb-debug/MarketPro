import { previewSegmentCount } from '@repo/core/api/segments';
import { readBody, withContext } from '../../_lib/route';

export async function POST(req: Request) {
  const body = await readBody(req);
  return withContext(req, (ctx) => previewSegmentCount(ctx, body));
}
