import {
  addSegmentContacts,
  listSegmentContacts,
  removeSegmentContacts,
} from '@repo/core/api/segments';
import { readBody, withContext, type RouteParams } from '../../../_lib/route';

export async function GET(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  const url = new URL(req.url);
  return withContext(req, (ctx) =>
    listSegmentContacts(ctx, id, {
      pageSize: url.searchParams.get('pageSize'),
      cursor: url.searchParams.get('cursor'),
    }),
  );
}

export async function POST(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  const body = await readBody(req);
  return withContext(req, (ctx) => addSegmentContacts(ctx, id, body));
}

export async function DELETE(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  const body = await readBody(req);
  return withContext(req, (ctx) => removeSegmentContacts(ctx, id, body));
}
