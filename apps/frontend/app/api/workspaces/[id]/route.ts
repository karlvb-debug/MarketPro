import { deleteWorkspace, renameWorkspace } from '@repo/core/api/workspaces';
import { readBody, withContext, type RouteParams } from '../../_lib/route';

export async function PUT(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  const body = await readBody(req);
  return withContext(req, (ctx) => renameWorkspace(ctx, id, body));
}

export async function DELETE(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  return withContext(req, (ctx) => deleteWorkspace(ctx, id));
}
