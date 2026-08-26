import { createTemplate, listTemplates } from '@repo/core/api/templates';
import { readBody, withContext, type RouteParams } from '../../_lib/route';

export async function GET(req: Request, { params }: RouteParams<{ type: string }>) {
  const { type } = await params;
  return withContext(req, (ctx) => listTemplates(ctx, type));
}

export async function POST(req: Request, { params }: RouteParams<{ type: string }>) {
  const { type } = await params;
  const body = await readBody(req);
  return withContext(req, (ctx) => createTemplate(ctx, type, body));
}
