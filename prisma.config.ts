import { defineConfig } from 'prisma/config';
require('./scripts/load-env.cjs').loadEnvironment();
if (process.env.NODE_ENV === 'production' && !process.env.MIGRATION_DATABASE_URL) {
  throw new Error('Production migrations require MIGRATION_DATABASE_URL');
}
// Prisma 6's classic engine still reads the URL from the schema environment.
// This assignment is confined to the CLI config; it is never imported by Nest.
if (process.env.MIGRATION_DATABASE_URL) process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;

// Migrations use a separate schema owner; Nest only uses DATABASE_URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'node scripts/seed-demo-data.cjs' },
  datasource: { url: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || '' },
});
