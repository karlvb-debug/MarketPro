import { deleteTemplate, getTemplate, updateTemplate } from '@repo/core/api/templates';
import { readBody, withContext, type RouteParams } from '../../../_lib/route';

type Params = RouteParams<{ type: string; id: string }>;

export async function GET(req: Request, { params }: Params) {
  const { type, id } = await params;
  return withContext(req, (ctx) => getTemplate(ctx, type, id));
}

export async function PUT(req: Request, { params }: Params) {
  const { type, id } = await params;
  const body = await readBody(req);
  return withContext(req, (ctx) => updateTemplate(ctx, type, id, body));
}

export async function DELETE(req: Request, { params }: Params) {
  const { type, id } = await params;
  return withContext(req, (ctx) => deleteTemplate(ctx, type, id));
}
