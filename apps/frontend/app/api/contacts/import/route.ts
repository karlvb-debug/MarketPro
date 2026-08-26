import { importContacts } from '@repo/core/api/contacts';
import { readBody, withContext } from '../../_lib/route';

export async function POST(req: Request) {
  const body = await readBody(req);
  return withContext(req, (ctx) => importContacts(ctx, body));
}
