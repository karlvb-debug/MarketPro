import { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import csv from 'csv-parser';
import { eq, sql } from 'drizzle-orm';
import { getDb } from './lib/db';
import { contacts } from '../drizzle/schema';
import { Readable } from 'stream';

const s3Client = new S3Client({});

interface ChunkInput {
  bucket: string;
  key: string;
}

export const handler = async (event: any) => {
  console.log('Parsing CSV...', JSON.stringify(event));

  // Step function passes the array, but we modified the trigger to pass a single object or an array of 1
  let input: ChunkInput;
  if (Array.isArray(event)) {
    input = event[0];
  } else {
    input = event;
  }

  const { bucket, key } = input;
  
  // Extract workspaceId from key: "workspaceId/import-xxxx.csv"
  const workspaceId = key.split('/')[0];
  if (!workspaceId) {
    throw new Error('Workspace ID not found in S3 key');
  }

  const db = getDb();

  const getObjectResponse = await s3Client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));

  const stream = getObjectResponse.Body as Readable;

  let batch: any[] = [];
  let processedRows = 0;
  let insertedRows = 0;
  const BATCH_SIZE = 1000;

  const processBatch = async (rows: any[]) => {
    if (rows.length === 0) return;

    // Filter invalid rows
    const validRows = rows.map(r => ({
      workspaceId,
      email: r.email || null,
      phone: r.phone || null,
      firstName: r.firstName || null,
      lastName: r.lastName || null,
      company: r.company || null,
      timezone: r.timezone || null,
      state: r.state || null,
      status: 'active' as const,
      source: 'csv_import',
      consentSource: 'bulk_import',
      customFields: {},
    })).filter(r => r.email || r.phone || r.firstName || r.lastName);

    if (validRows.length === 0) return;

    const withEmail = validRows.filter(c => c.email);
    const phoneOnly = validRows.filter(c => !c.email && c.phone);

    // Pass 1: Upsert contacts WITH email
    if (withEmail.length > 0) {
      const result = await db
        .insert(contacts)
        .values(withEmail)
        .onConflictDoUpdate({
          target: [contacts.workspaceId, contacts.email],
          set: {
            firstName: sql`COALESCE(EXCLUDED."first_name", ${contacts.firstName})`,
            lastName: sql`COALESCE(EXCLUDED."last_name", ${contacts.lastName})`,
            phone: sql`COALESCE(EXCLUDED."phone", ${contacts.phone})`,
            company: sql`COALESCE(EXCLUDED."company", ${contacts.company})`,
            timezone: sql`COALESCE(EXCLUDED."timezone", ${contacts.timezone})`,
            state: sql`COALESCE(EXCLUDED."state", ${contacts.state})`,
            updatedAt: new Date(),
          },
        })
        .returning({ contactId: contacts.contactId });
      insertedRows += result.length;
    }

    // Pass 2: Upsert phone-only contacts
    if (phoneOnly.length > 0) {
      const result = await db
        .insert(contacts)
        .values(phoneOnly)
        .onConflictDoUpdate({
          target: [contacts.workspaceId, contacts.phone],
          set: {
            firstName: sql`COALESCE(EXCLUDED."first_name", ${contacts.firstName})`,
            lastName: sql`COALESCE(EXCLUDED."last_name", ${contacts.lastName})`,
            company: sql`COALESCE(EXCLUDED."company", ${contacts.company})`,
            timezone: sql`COALESCE(EXCLUDED."timezone", ${contacts.timezone})`,
            state: sql`COALESCE(EXCLUDED."state", ${contacts.state})`,
            updatedAt: new Date(),
          },
        })
        .returning({ contactId: contacts.contactId });
      insertedRows += result.length;
    }
  };

  return new Promise((resolve, reject) => {
    stream
      .pipe(csv())
      .on('data', async (data) => {
        processedRows++;
        batch.push(data);
        if (batch.length >= BATCH_SIZE) {
          // Pause stream while processing batch
          stream.pause();
          try {
            await processBatch(batch);
            batch = [];
            stream.resume();
          } catch (err) {
            reject(err);
          }
        }
      })
      .on('end', async () => {
        try {
          if (batch.length > 0) {
            await processBatch(batch);
          }
          console.log(`Finished processing. Total rows: ${processedRows}, Inserted/Updated: ${insertedRows}`);
          resolve({
            status: 'SUCCESS',
            processedRows,
            insertedRows,
          });
        } catch (err) {
          reject(err);
        }
      })
      .on('error', (error) => {
        console.error('Stream error:', error);
        reject(error);
      });
  });
};
