import { getContactTimeline } from '@repo/core/api/contacts';
import { withContext, type RouteParams } from '../../../_lib/route';

export async function GET(req: Request, { params }: RouteParams<{ id: string }>) {
  const { id } = await params;
  const url = new URL(req.url);
  return withContext(req, (ctx) =>
    getContactTimeline(ctx, id, {
      pageSize: url.searchParams.get('pageSize'),
      cursor: url.searchParams.get('cursor'),
    }),
  );
}
