import { listDuplicates } from '@repo/core/api/contacts';
import { withContext } from '../../_lib/route';

export async function GET(req: Request) {
  const url = new URL(req.url);
  return withContext(req, (ctx) => listDuplicates(ctx, { limit: url.searchParams.get('limit') }));
}
