import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './drizzle/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // For local development, use a direct connection string.
    // In production, this points to the RDS Proxy endpoint via Secrets Manager.
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/marketingsaas',
  },
  verbose: true,
  strict: true,
});
