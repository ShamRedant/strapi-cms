/**
 * Standalone Script: Reset lessons with missing S3 files
 *
 * If you deleted objects from S3, Strapi still has DB records + relations pointing to them.
 * This script detects missing S3 objects and "resets" the lesson by detaching the media field(s)
 * (sets the lesson's media FK to NULL). After this, you can re-upload files in Strapi admin.
 *
 * Usage:
 *   node scripts/reset-missing-s3-files.js                 # Dry run (no DB changes)
 *   node scripts/reset-missing-s3-files.js --execute       # Actually detach missing media from lessons
 *
 * Requires .env in project root with:
 * - DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USERNAME, DATABASE_PASSWORD
 * - AWS_REGION, AWS_ACCESS_KEY_ID, AWS_ACCESS_SECRET, AWS_BUCKET
 */

// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');

// ----------------------------
// Env loading
// ----------------------------
const envPath = path.join(__dirname, '..', '.env');
let envLoaded = false;

try {
  require('dotenv').config({ path: envPath });
  envLoaded = true;
} catch (e) {
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach((line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) return;
      const [key, ...valueParts] = trimmedLine.split('=');
      if (!key || valueParts.length === 0) return;
      const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
      if (!process.env[key.trim()]) process.env[key.trim()] = value;
    });
    envLoaded = true;
  }
}

if (!envLoaded) {
  console.warn(`⚠️  Warning: .env file not found at ${envPath}`);
}

// ----------------------------
// Flags / config
// ----------------------------
const EXECUTE = process.argv.includes('--execute');

const config = {
  database: {
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT, 10) || 5432,
    user: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'strapi',
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  },
  s3: {
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_ACCESS_SECRET,
    bucket: process.env.AWS_BUCKET,
  },
};

function requiredVarsMissing() {
  const missing = [];
  if (!config.s3.bucket) missing.push('AWS_BUCKET');
  if (!config.s3.region) missing.push('AWS_REGION');
  if (!config.s3.accessKeyId) missing.push('AWS_ACCESS_KEY_ID');
  if (!config.s3.secretAccessKey) missing.push('AWS_ACCESS_SECRET');
  return missing;
}

const s3Client = new S3Client({
  region: config.s3.region,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
});

async function s3Exists(key) {
  if (!key) return false;
  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
      })
    );
    return true;
  } catch (err) {
    if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return false;
    // If permissions or other errors, rethrow so you see it
    throw err;
  }
}

function extractKeyFromUrl(url) {
  if (!url) return null;
  const m = url.match(/\.amazonaws\.com\/(.+)$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

async function main() {
  console.log('\n========================================');
  console.log('  RESET MISSING S3 FILES (LESSONS)');
  console.log(`  MODE: ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);
  console.log('========================================\n');

  const missingVars = requiredVarsMissing();
  if (missingVars.length) {
    console.error('❌ Missing S3 configuration env vars:');
    missingVars.forEach((v) => console.error(`   - ${v}`));
    process.exit(1);
  }

  console.log('Configuration:');
  console.log(`  Database: ${config.database.host}:${config.database.port}/${config.database.database}`);
  console.log(`  S3 Bucket: ${config.s3.bucket}`);
  console.log(`  S3 Region: ${config.s3.region}\n`);

  const pool = new Pool(config.database);
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    console.error('❌ Database connection failed:', e.message);
    process.exit(1);
  }

  // media fields on lessons (single media)
  const mediaFields = ['student_file', 'homework_file', 'teacher_file', 'ppt_file'];

  // Determine which Strapi upload morph relation table exists
  // Common variants:
  // - files_related_morphs (Strapi v4)
  // - files_related_mph (some projects / migrations)
  const relationTables = ['files_related_morphs', 'files_related_mph'];
  let relationTable = null;
  for (const t of relationTables) {
    const r = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name=$1)`,
      [t]
    );
    if (r.rows?.[0]?.exists) {
      relationTable = t;
      break;
    }
  }

  if (!relationTable) {
    console.error('❌ Could not find upload relation table.');
    console.error(`   Tried: ${relationTables.join(', ')}`);
    console.error('   Your Strapi schema may use different table names.');
    process.exit(1);
  }

  console.log(`Using upload relation table: ${relationTable}\n`);

  let totalChecked = 0;
  let totalMissing = 0;
  let totalDetached = 0;

  for (const field of mediaFields) {
    console.log(`\n🔎 Checking field: ${field}`);

    // Pull all file relations for lessons for this field from the morph pivot
    // Expected columns in pivot: id, file_id, related_id, related_type, field
    const links = await pool.query(
      `
      SELECT
        frm.id as rel_id,
        frm.related_id as lesson_id,
        frm.file_id as file_id,
        frm.field as field_name,
        f.name as file_name,
        f.url as file_url,
        f.hash as file_hash,
        f.ext as file_ext,
        f.provider_metadata as provider_metadata
      FROM ${relationTable} frm
      INNER JOIN files f ON f.id = frm.file_id
      WHERE frm.related_type = 'api::lesson.lesson'
        AND frm.field = $1
      `,
      [field]
    );

    for (const row of links.rows) {
      totalChecked++;
      let key = null;

      if (row.provider_metadata) {
        try {
          const md = typeof row.provider_metadata === 'string' ? JSON.parse(row.provider_metadata) : row.provider_metadata;
          key = md?.key || null;
        } catch {
          // ignore
        }
      }

      if (!key) key = extractKeyFromUrl(row.file_url);
      if (!key && row.file_hash) key = `${row.file_hash}${row.file_ext || ''}`;

      let existsInS3 = false;
      try {
        existsInS3 = await s3Exists(key);
      } catch (e) {
        console.error(`   ❌ S3 check error for key="${key}" file_id=${row.file_id}: ${e.message}`);
        continue;
      }

      if (existsInS3) continue;

      totalMissing++;
      console.log(`   ⚠️ Missing in S3: lesson_id=${row.lesson_id} file_id=${row.file_id} name="${row.file_name}" key="${key}"`);

      if (!EXECUTE) continue;

      const del = await pool.query(`DELETE FROM ${relationTable} WHERE id=$1`, [row.rel_id]);
      if (del.rowCount > 0) totalDetached += del.rowCount;
    }
  }

  console.log('\n========================================');
  console.log('  SUMMARY');
  console.log('========================================');
  console.log(`  Total lesson-file links checked: ${totalChecked}`);
  console.log(`  Missing S3 objects found:        ${totalMissing}`);
  console.log(`  Links detached:                 ${EXECUTE ? totalDetached : 0}`);
  console.log('========================================\n');

  if (!EXECUTE) {
    console.log('To actually detach missing media links, run:');
    console.log('  node scripts/reset-missing-s3-files.js --execute\n');
  } else {
    console.log('✅ Done. Now open the lesson in Strapi admin and re-upload the files.\n');
  }

  await pool.end();
}

main().catch((e) => {
  console.error('❌ Script error:', e.message);
  process.exit(1);
});


