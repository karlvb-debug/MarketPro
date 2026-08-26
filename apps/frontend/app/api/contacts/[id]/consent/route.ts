import { getContactConsent } from '@repo/core/api/contacts';
import { withContext, type RouteParams } from '../../../_lib/route';

export async function GET(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  return withContext(req, (ctx) => getContactConsent(ctx, id));
}
