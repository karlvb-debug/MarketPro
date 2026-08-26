// ============================================
// Export worker — async-invoked per export job. Streams the matching
// contacts to a CSV in S3 (multipart, flat memory), then marks the job
// complete with the row count and object key. Any failure marks the job
// failed with the error so the API can report it.
// ============================================

import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getPool } from './lib/db';
import { runExport } from '@repo/core/export';
import { Selection } from '@repo/core/bulk';
import { Logger } from '@repo/core/logger';

const s3 = new S3Client({});
const BUCKET = process.env.EXPORT_BUCKET || '';
// S3 multipart parts must be >= 5 MiB (except the last).
const PART_THRESHOLD = 5 * 1024 * 1024;

export interface ExportJobEvent {
  jobId: string;
  workspaceId: string;
}

export const handler = async (event: ExportJobEvent): Promise<void> => {
  const logger = new Logger({ handler: 'export-worker', jobId: event.jobId, workspaceId: event.workspaceId });
  const pool = await getPool();

  const job = await pool.query(
    `SELECT selection, columns FROM export_jobs WHERE job_id = $1 AND workspace_id = $2`,
    [event.jobId, event.workspaceId],
  );
  if (job.rows.length === 0) {
    logger.error('Export job not found');
    return;
  }
  const selection = job.rows[0].selection as Selection;
  const columns = job.rows[0].columns as string[] | null;
  const key = `exports/${event.workspaceId}/${event.jobId}.csv`;

  await pool.query(`UPDATE export_jobs SET status = 'running' WHERE job_id = $1`, [event.jobId]);

  // Multipart upload with a buffered sink that flushes at the part threshold.
  let uploadId: string | undefined;
  try {
    const created = await s3.send(new CreateMultipartUploadCommand({
      Bucket: BUCKET, Key: key, ContentType: 'text/csv',
    }));
    uploadId = created.UploadId!;
    const partTags: { ETag?: string; PartNumber: number }[] = [];
    let buffer = '';
    let partNumber = 1;

    const flush = async (force: boolean) => {
      if (buffer.length === 0) return;
      if (!force && buffer.length < PART_THRESHOLD) return;
      const body = buffer;
      buffer = '';
      const res = await s3.send(new UploadPartCommand({
        Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body,
      }));
      partTags.push({ ETag: res.ETag, PartNumber: partNumber });
      partNumber++;
    };

    const result = await runExport(pool, event.workspaceId, selection, columns, {
      write: async (chunk) => { buffer += chunk; await flush(false); },
    });
    await flush(true);

    // Empty result still needs at least one (header-only) part — flush(true) handled it.
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: BUCKET, Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: partTags },
    }));

    await pool.query(
      `UPDATE export_jobs SET status = 'complete', row_count = $2, s3_key = $3, completed_at = NOW() WHERE job_id = $1`,
      [event.jobId, result.rowCount, key],
    );
    logger.info('Export complete', { rowCount: result.rowCount });
  } catch (err) {
    if (uploadId) {
      await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId })).catch(() => undefined);
    }
    await pool.query(
      `UPDATE export_jobs SET status = 'failed', error = $2, completed_at = NOW() WHERE job_id = $1`,
      [event.jobId, err instanceof Error ? err.message : String(err)],
    );
    logger.error('Export failed', err);
  }
};
