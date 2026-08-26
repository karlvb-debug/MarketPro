import { bulkDeleteContacts, createContact, listContacts } from '@repo/core/api/contacts';
import { readBody, withContext } from '../_lib/route';

export async function GET(req: Request) {
  const url = new URL(req.url);
  return withContext(req, (ctx) =>
    listContacts(ctx, {
      pageSize: url.searchParams.get('pageSize'),
      cursor: url.searchParams.get('cursor'),
      status: url.searchParams.get('status'),
      search: url.searchParams.get('search'),
      segmentId: url.searchParams.get('segmentId'),
    }),
  );
}

export async function POST(req: Request) {
  const body = await readBody(req);
  return withContext(req, (ctx) => createContact(ctx, body));
}

export async function DELETE(req: Request) {
  const body = await readBody(req);
  return withContext(req, (ctx) => bulkDeleteContacts(ctx, body));
}
