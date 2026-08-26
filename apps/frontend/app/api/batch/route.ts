import { loadBatch } from '@repo/core/api/batch';
import { withContext } from '../_lib/route';

export async function GET(req: Request) {
  return withContext(req, loadBatch);
}
