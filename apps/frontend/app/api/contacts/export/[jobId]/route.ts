import { getExportStatus } from '@repo/core/api/contacts';
import { withContext, type RouteParams } from '../../../_lib/route';
import { contactsDeps } from '../../../_lib/storage';

export async function GET(req: Request, { params }: RouteParams<{ jobId: string }>) {
  const { jobId } = await params;
  return withContext(req, (ctx) => getExportStatus(ctx, jobId, contactsDeps));
}
