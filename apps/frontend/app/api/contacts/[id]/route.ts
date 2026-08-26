import { deleteContact, getContact, updateContact } from '@repo/core/api/contacts';
import { readBody, requestMeta, withContext, type RouteParams } from '../../_lib/route';

export async function GET(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  return withContext(req, (ctx) => getContact(ctx, id));
}

export async function PUT(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  const body = await readBody(req);
  return withContext(req, (ctx) => updateContact(ctx, id, body));
}

export async function DELETE(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  return withContext(req, (ctx) => deleteContact(ctx, id, requestMeta(req)));
}
