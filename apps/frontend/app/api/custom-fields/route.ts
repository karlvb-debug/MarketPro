import { createCustomField, listCustomFields } from '@repo/core/api/custom-fields';
import { readBody, withContext } from '../_lib/route';

export async function GET(req: Request) {
  return withContext(req, listCustomFields);
}

export async function POST(req: Request) {
  const body = await readBody(req);
  return withContext(req, (ctx) => createCustomField(ctx, body));
}
