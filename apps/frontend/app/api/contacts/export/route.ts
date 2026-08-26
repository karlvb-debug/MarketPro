import { startContactExport } from '@repo/core/api/contacts';
import { readBody, withContext } from '../../_lib/route';
import { contactsDeps } from '../../_lib/storage';

export async function POST(req: Request) {
  const body = await readBody(req);
  return withContext(req, (ctx) => startContactExport(ctx, body, contactsDeps));
}
