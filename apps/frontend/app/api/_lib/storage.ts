// ============================================
// Object storage + async worker dependencies for the contacts routes.
//
// CSV upload/download and the export worker are the last pieces still tied to
// AWS (S3 presigning, Lambda Event invocation). M6 moves them to Supabase
// Storage and a queued job. Until then these are deliberately unwired: the
// core handlers treat an absent dependency the same way the Lambda treated a
// missing bucket/function env var — a 500 on import-url, and an export job
// that is recorded but reports no download URL.
// ============================================

import type { ContactsDeps } from '@repo/core/api/contacts';

export const contactsDeps: ContactsDeps = {};
