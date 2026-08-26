import { createImportUrl } from '@repo/core/api/contacts';
import { withContext } from '../../_lib/route';
import { contactsDeps } from '../../_lib/storage';

export async function GET(req: Request) {
  const url = new URL(req.url);
  return withContext(req, (ctx) =>
    createImportUrl(ctx, { segmentId: url.searchParams.get('segmentId') }, contactsDeps),
  );
}
