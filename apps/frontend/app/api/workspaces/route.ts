import { createWorkspace, listWorkspaces } from '@repo/core/api/workspaces';
import { readBody, withContext } from '../_lib/route';

export async function GET(req: Request) {
  return withContext(req, listWorkspaces);
}

export async function POST(req: Request) {
  const body = await readBody(req);
  return withContext(req, (ctx) => createWorkspace(ctx, body));
}
