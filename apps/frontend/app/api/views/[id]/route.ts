import { deleteView, updateView } from '@repo/core/api/views';
import { readBody, withContext, type RouteParams } from '../../_lib/route';

export async function PUT(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  const body = await readBody(req);
  return withContext(req, (ctx) => updateView(ctx, id, body));
}

export async function DELETE(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  return withContext(req, (ctx) => deleteView(ctx, id));
}
