/**
 * Standalone Script: Reorganize Already Uploaded Files
 * 
 * This script moves existing uploaded files into the correct folder structure
 * based on course/module/lesson from the database.
 * 
 * Usage: 
 *   node scripts/reorganize-files.js          # Dry run (preview only)
 *   node scripts/reorganize-files.js --execute # Actually move files
 * 
 * Make sure to run from project root and have .env configured with:
 * - DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USERNAME, DATABASE_PASSWORD
 * - AWS_REGION, AWS_ACCESS_KEY_ID, AWS_ACCESS_SECRET, AWS_BUCKET
 */

'use strict';

// Load environment variables from .env file
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not installed, try loading .env manually
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
        if (!process.env[key.trim()]) {
          process.env[key.trim()] = value;
        }
      }
    });
  }
}

// Check for --execute flag
const DRY_RUN = !process.argv.includes('--execute');

const { S3Client, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');

// ============================================
// Configuration from environment
// ============================================
const config = {
  database: {
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT) || 5432,
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

// ============================================
// S3 Client
// ============================================
const s3Client = new S3Client({
  region: config.s3.region,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
});

// ============================================
// Utility Functions
// ============================================

/**
 * Sanitize name for S3 key (same as existing code)
 */
function sanitizeName(name) {
  if (!name) return 'unknown';
  return name
    .toString()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    || 'file';
}

/**
 * Check if file exists in S3
 */
async function fileExistsInS3(key) {
  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
    }));
    return true;
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

/**
 * Move file in S3 from old location to new location
 */
async function moveFileInS3(oldKey, newKey, contentType) {
  // Check if source file exists
  const sourceExists = await fileExistsInS3(oldKey);
  if (!sourceExists) {
    console.log(`  ⚠️ Source file not found in S3: ${oldKey}`);
    return false;
  }

  // Check if destination already exists
  const destExists = await fileExistsInS3(newKey);
  if (destExists) {
    console.log(`  ℹ️ Destination already exists: ${newKey}`);
    // Delete old file if different from new
    if (oldKey !== newKey) {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: config.s3.bucket,
        Key: oldKey,
      }));
      console.log(`  ✓ Deleted old file: ${oldKey}`);
    }
    return true;
  }

  // Copy to new location
  console.log(`  📁 Copying: ${oldKey} → ${newKey}`);
  await s3Client.send(new CopyObjectCommand({
    Bucket: config.s3.bucket,
    CopySource: `${config.s3.bucket}/${encodeURIComponent(oldKey)}`,
    Key: newKey,
    ContentType: contentType || 'application/octet-stream',
    MetadataDirective: 'REPLACE',
  }));

  // Delete old file
  await s3Client.send(new DeleteObjectCommand({
    Bucket: config.s3.bucket,
    Key: oldKey,
  }));
  console.log(`  ✓ Moved successfully`);

  return true;
}

// ============================================
// Main Logic
// ============================================

async function main() {
  console.log('\n========================================');
  console.log('  FILE REORGANIZATION SCRIPT');
  if (DRY_RUN) {
    console.log('  MODE: DRY RUN (preview only)');
    console.log('  Use --execute flag to actually move files');
  } else {
    console.log('  MODE: EXECUTE (will move files)');
  }
  console.log('========================================\n');

  // Validate configuration
  if (!config.s3.bucket || !config.s3.region || !config.s3.accessKeyId) {
    console.error('❌ Missing S3 configuration. Check your .env file.');
    process.exit(1);
  }

  console.log('Configuration:');
  console.log(`  Database: ${config.database.host}:${config.database.port}/${config.database.database}`);
  console.log(`  S3 Bucket: ${config.s3.bucket}`);
  console.log(`  S3 Region: ${config.s3.region}\n`);

  // Connect to database
  let pool;
  try {
    console.log('🔌 Connecting to database...');
    pool = new Pool(config.database);
    // Test connection
    await pool.query('SELECT 1');
    console.log('✓ Database connected\n');
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    process.exit(1);
  }

  try {
    // Get all lessons with their modules and courses
    console.log('📚 Fetching lessons with modules and courses...\n');

    const lessonsResult = await pool.query(`
      SELECT 
        l.id as lesson_id,
        l.document_id as lesson_document_id,
        l.title as lesson_title,
        m.id as module_id,
        m.title as module_title,
        c.id as course_id,
        c.course_title as course_title
      FROM lessons l
      LEFT JOIN lessons_module_lnk lml ON l.id = lml.lesson_id
      LEFT JOIN modules m ON lml.module_id = m.id
      LEFT JOIN modules_course_lnk mcl ON m.id = mcl.module_id
      LEFT JOIN courses c ON mcl.course_id = c.id
      WHERE l.published_at IS NOT NULL
      ORDER BY c.course_title, m.title, l.title
    `);

    const lessons = lessonsResult.rows;
    console.log(`Found ${lessons.length} lessons\n`);

    if (lessons.length === 0) {
      console.log('No lessons found. Nothing to reorganize.');
      return;
    }

    // File fields to check for each lesson
    const fileFields = ['student_file', 'homework_file', 'teacher_file', 'ppt_file'];

    let totalFilesProcessed = 0;
    let totalFilesMoved = 0;
    let totalFilesSkipped = 0;
    let totalFilesErrors = 0;

    // Process each lesson
    for (const lesson of lessons) {
      const courseName = sanitizeName(lesson.course_title || 'Uncategorized');
      const moduleName = sanitizeName(lesson.module_title || 'Module');
      const lessonName = sanitizeName(lesson.lesson_title || 'Lesson');

      console.log(`\n📖 Lesson: "${lesson.lesson_title}"`);
      console.log(`   Course: ${lesson.course_title || 'N/A'}`);
      console.log(`   Module: ${lesson.module_title || 'N/A'}`);
      console.log(`   Target folder: ${courseName}/${moduleName}/${lessonName}/`);

      // Get files linked to this lesson
      for (const fieldName of fileFields) {
        // Query the files_related_mph table to find files linked to this lesson
        const fileLinksResult = await pool.query(`
          SELECT 
            f.id as file_id,
            f.name as file_name,
            f.url as file_url,
            f.ext as file_ext,
            f.mime as file_mime,
            f.hash as file_hash,
            f.provider_metadata as provider_metadata,
            frm.field as field_name
          FROM files f
          INNER JOIN files_related_mph frm ON f.id = frm.file_id
          WHERE frm.related_id = $1
            AND frm.related_type = 'api::lesson.lesson'
            AND frm.field = $2
        `, [lesson.lesson_id, fieldName]);

        for (const file of fileLinksResult.rows) {
          totalFilesProcessed++;

          console.log(`\n   📄 File: ${file.file_name} (${fieldName})`);

          // Determine current S3 key
          let currentKey = null;
          if (file.provider_metadata) {
            try {
              const metadata = typeof file.provider_metadata === 'string' 
                ? JSON.parse(file.provider_metadata) 
                : file.provider_metadata;
              currentKey = metadata.key;
            } catch (e) {
              // Ignore parse error
            }
          }

          // If no key in metadata, try to extract from URL
          if (!currentKey && file.file_url) {
            const urlMatch = file.file_url.match(/\.amazonaws\.com\/(.+)$/);
            if (urlMatch) {
              currentKey = decodeURIComponent(urlMatch[1]);
            }
          }

          // Fallback to hash + ext
          if (!currentKey) {
            currentKey = `${file.file_hash}${file.file_ext}`;
          }

          // Build new key based on folder structure
          // Format: course/module/lesson/filename
          const newKey = `${courseName}/${moduleName}/${lessonName}/${file.file_name}`;

          console.log(`      Current key: ${currentKey}`);
          console.log(`      New key: ${newKey}`);

          // Check if already in correct location
          if (currentKey === newKey) {
            console.log(`      ✓ Already in correct location`);
            totalFilesSkipped++;
            continue;
          }

          // Move file in S3
          if (DRY_RUN) {
            console.log(`      🔍 [DRY RUN] Would move file`);
            totalFilesMoved++;
          } else {
            try {
              const moved = await moveFileInS3(currentKey, newKey, file.file_mime);

              if (moved) {
                // Update database record
                const newUrl = `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${newKey}`;
                const newMetadata = JSON.stringify({ key: newKey, bucket: config.s3.bucket });

                await pool.query(`
                  UPDATE files 
                  SET url = $1, provider_metadata = $2
                  WHERE id = $3
                `, [newUrl, newMetadata, file.file_id]);

                console.log(`      ✓ Database updated with new URL`);
                totalFilesMoved++;
              } else {
                totalFilesSkipped++;
              }
            } catch (error) {
              console.error(`      ❌ Error moving file: ${error.message}`);
              totalFilesErrors++;
            }
          }
        }
      }
    }

    // Print summary
    console.log('\n========================================');
    console.log('  SUMMARY');
    if (DRY_RUN) {
      console.log('  (DRY RUN - no changes made)');
    }
    console.log('========================================');
    console.log(`  Total files processed: ${totalFilesProcessed}`);
    console.log(`  Files ${DRY_RUN ? 'would be moved' : 'moved'}: ${totalFilesMoved}`);
    console.log(`  Files skipped: ${totalFilesSkipped}`);
    console.log(`  Errors: ${totalFilesErrors}`);
    console.log('========================================');
    if (DRY_RUN && totalFilesMoved > 0) {
      console.log('\n  To actually move files, run:');
      console.log('  node scripts/reorganize-files.js --execute\n');
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    if (pool) {
      await pool.end();
      console.log('🔌 Database connection closed');
    }
  }
}

// Run the script
main().catch(console.error);
