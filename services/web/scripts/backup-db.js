#!/usr/bin/env node

// Simple Postgres backup helper. Attempts to use pg_dump when available.
// Falls back to docker compose or Prisma-based JSON dump if needed.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseDatabaseUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (error) {
    throw new Error(`Invalid DATABASE_URL: ${urlString}`);
  }

  if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported protocol in DATABASE_URL: ${parsed.protocol}`);
  }

  const database = parsed.pathname.replace(/^\//, '');
  if (!database) {
    throw new Error('DATABASE_URL is missing the database name.');
  }

  return {
    host: parsed.hostname || 'localhost',
    port: parsed.port || '5432',
    user: decodeURIComponent(parsed.username || 'postgres'),
    password: decodeURIComponent(parsed.password || ''),
    database,
  };
}

function runPgDump(targetFile, dbConfig) {
  const args = [
    `--host=${dbConfig.host}`,
    `--port=${dbConfig.port}`,
    `--username=${dbConfig.user}`,
    `--dbname=${dbConfig.database}`,
    '--no-owner',
    '--no-acl',
    '--format=plain',
    `--file=${targetFile}`,
  ];

  const env = { ...process.env };
  if (dbConfig.password) {
    env.PGPASSWORD = dbConfig.password;
  }

  console.log(`[backup] Running pg_dump -> ${targetFile}`);
  const result = spawnSync('pg_dump', args, { env, stdio: 'inherit' });
  return result.status === 0;
}

function runDockerPgDump(targetFile, dbConfig) {
  const args = [
    'compose',
    'exec',
    '-T',
    'postgres',
    'pg_dump',
    `--username=${dbConfig.user}`,
    `--dbname=${dbConfig.database}`,
    '--no-owner',
    '--no-acl',
  ];

  const env = { ...process.env };
  if (dbConfig.password) {
    env.PGPASSWORD = dbConfig.password;
  }

  console.log('[backup] pg_dump command missing. Trying docker compose exec postgres pg_dump');
  const result = spawnSync('docker', args, { env, stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.status === 0 && result.stdout) {
    fs.writeFileSync(targetFile, result.stdout);
    return true;
  }
  return false;
}

async function runPrismaDump(targetFile, dbUrl) {
  console.log('[backup] Falling back to Prisma JSON export.');
  let PrismaClient;
  try {
    ({ PrismaClient } = require('@prisma/client'));
  } catch (error) {
    console.error('[backup] Failed to load @prisma/client. Did you run `npx prisma generate`?');
    throw error;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  try {
    const tables = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;`;
    const data = {
      generatedAt: new Date().toISOString(),
      tables: {},
    };

    for (const row of tables) {
      const tableName = row.tablename;
      const records = await prisma.$queryRawUnsafe(`SELECT * FROM "${tableName}"`);
      data.tables[tableName] = records;
    }

    const json = JSON.stringify(data, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
    fs.writeFileSync(targetFile, json);
    console.log(`[backup] Wrote Prisma JSON backup -> ${targetFile}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL not set. Aborting backup.');
    process.exit(1);
  }

  const dbConfig = parseDatabaseUrl(databaseUrl);

  const outDir = path.resolve(__dirname, '../backups');
  ensureDir(outDir);
  const stamp = timestamp();
  const sqlTarget = path.join(outDir, `db-backup-${stamp}.sql`);
  const jsonTarget = path.join(outDir, `db-backup-${stamp}.json`);

  const pgDumpAvailable = spawnSync('pg_dump', ['--version'], { stdio: 'ignore' }).status === 0;

  if (pgDumpAvailable) {
    const ok = runPgDump(sqlTarget, dbConfig);
    if (ok) {
      console.log('[backup] Backup completed via pg_dump.');
      return;
    }
    console.warn('[backup] pg_dump failed.');
  } else {
    console.warn('[backup] pg_dump command not found.');
  }

  const dockerAvailable = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;
  if (dockerAvailable) {
    const ok = runDockerPgDump(sqlTarget, dbConfig);
    if (ok) {
      console.log('[backup] Backup completed via docker compose exec.');
      return;
    }
    console.warn('[backup] docker compose pg_dump fallback failed.');
  } else {
    console.warn('[backup] docker compose not available or not running.');
  }

  await runPrismaDump(jsonTarget, databaseUrl);
}

main().catch((error) => {
  console.error('[backup] Failed to create backup:', error);
  process.exit(1);
});
