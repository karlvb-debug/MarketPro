// ============================================
// Contacts API — thin adapter over @repo/core/api/contacts.
//
// This file owns only the AWS-specific side-effects the core handlers take as
// injected dependencies: S3 presigning for CSV upload/download, and the Event
// invocation that starts the export worker.
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  bulkContactAction,
  bulkDeleteContacts,
  createContact,
  createImportUrl,
  deleteContact,
  getContact,
  getContactConsent,
  getContactTimeline,
  getExportStatus,
  importContacts,
  listContacts,
  listDuplicates,
  mergeDuplicates,
  searchContacts,
  startContactExport,
  updateContact,
  type ContactsDeps,
} from '@repo/core/api/contacts';
import { methodNotAllowed } from '@repo/core/api/result';
import { adapt, bodyOf, metaOf, queryOf } from '../lib/adapt';

const s3Client = new S3Client({});
const PRESIGN_TTL_SECONDS = 900; // 15 minutes

const UPLOAD_BUCKET = process.env.UPLOAD_BUCKET;
const EXPORT_BUCKET = process.env.EXPORT_BUCKET;
const EXPORT_WORKER = process.env.EXPORT_WORKER_FUNCTION;

/**
 * A dependency is left undefined when its bucket/function is not configured.
 * The core handlers treat that as "this deployment cannot do it" — a 500 on
 * import-url, and an export job that reports no download URL — which is what
 * the missing env var produced before.
 */
const deps: ContactsDeps = {
  presignUpload: UPLOAD_BUCKET
    ? (key) => getSignedUrl(
        s3Client,
        new PutObjectCommand({ Bucket: UPLOAD_BUCKET, Key: key, ContentType: 'text/csv' }),
        { expiresIn: PRESIGN_TTL_SECONDS },
      )
    : undefined,

  presignDownload: EXPORT_BUCKET
    ? (key) => getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: EXPORT_BUCKET, Key: key }),
        { expiresIn: PRESIGN_TTL_SECONDS },
      )
    : undefined,

  startExport: EXPORT_WORKER
    ? async (jobId, workspaceId) => {
        const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
        await new LambdaClient({}).send(new InvokeCommand({
          FunctionName: EXPORT_WORKER,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({ jobId, workspaceId })),
        }));
      }
    : undefined,
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> =>
  adapt(event, async (ctx) => {
    const method = event.httpMethod;
    const path = event.path || '';
    const pathId = event.pathParameters?.id;
    const params = queryOf(event);

    // --- GET ---------------------------------------------------------------
    if (method === 'GET') {
      if (path.endsWith('/import-url')) {
        return createImportUrl(ctx, { segmentId: params.segmentId }, deps);
      }
      if (path.endsWith('/duplicates')) {
        return listDuplicates(ctx, { limit: params.limit });
      }
      if (pathId && path.includes('/export/')) {
        return getExportStatus(ctx, pathId, deps);
      }
      if (pathId && path.endsWith('/timeline')) {
        return getContactTimeline(ctx, pathId, { pageSize: params.pageSize, cursor: params.cursor });
      }
      if (pathId && path.endsWith('/consent')) {
        return getContactConsent(ctx, pathId);
      }
      if (pathId) return getContact(ctx, pathId);
      return listContacts(ctx, {
        pageSize: params.pageSize,
        cursor: params.cursor,
        status: params.status,
        search: params.search,
        segmentId: params.segmentId,
      });
    }

    // --- POST --------------------------------------------------------------
    if (method === 'POST') {
      if (path.endsWith('/merge')) return mergeDuplicates(ctx, bodyOf(event));
      if (path.endsWith('/bulk')) return bulkContactAction(ctx, bodyOf(event));
      if (path.endsWith('/export')) return startContactExport(ctx, bodyOf(event), deps);
      if (path.endsWith('/search')) return searchContacts(ctx, bodyOf(event));
      if (path.endsWith('/import')) return importContacts(ctx, bodyOf(event));
      return createContact(ctx, bodyOf(event));
    }

    // --- PUT / DELETE ------------------------------------------------------
    if (method === 'PUT' && pathId) return updateContact(ctx, pathId, bodyOf(event));
    if (method === 'DELETE' && pathId) return deleteContact(ctx, pathId, metaOf(event));
    if (method === 'DELETE' && !pathId) return bulkDeleteContacts(ctx, bodyOf(event));

    return methodNotAllowed();
  });
