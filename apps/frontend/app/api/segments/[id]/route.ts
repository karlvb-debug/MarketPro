import { deleteSegment, updateSegment } from '@repo/core/api/segments';
import { readBody, withContext, type RouteParams } from '../../_lib/route';

export async function PUT(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  const body = await readBody(req);
  return withContext(req, (ctx) => updateSegment(ctx, id, body));
}

export async function DELETE(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  return withContext(req, (ctx) => deleteSegment(ctx, id));
}
