import { archiveCustomField, updateCustomField } from '@repo/core/api/custom-fields';
import { readBody, withContext, type RouteParams } from '../../_lib/route';

export async function PUT(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  const body = await readBody(req);
  return withContext(req, (ctx) => updateCustomField(ctx, id, body));
}

/** DELETE archives — definitions are never destroyed. */
export async function DELETE(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  return withContext(req, (ctx) => archiveCustomField(ctx, id));
}
