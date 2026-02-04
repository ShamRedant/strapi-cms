/**
 * Standalone Script: Reorganize Already Uploaded Files
 * 
 * This script moves existing uploaded files into the correct folder structure
 * based on course/module/lesson from the database.
 * 
 * Usage: 
 *   node scripts/reorganize-files.js                    # Dry run (preview only)
 *   node scripts/reorganize-files.js --execute          # Actually move files
 *   node scripts/reorganize-files.js --execute --clean  # Move files and clean tables
 * 
 * Make sure to run from project root and have .env configured with:
 * - DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USERNAME, DATABASE_PASSWORD
 * - AWS_REGION, AWS_ACCESS_KEY_ID, AWS_ACCESS_SECRET, AWS_BUCKET
 */

'use strict';

// Load environment variables from .env file
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');

let envLoaded = false;

// Try using dotenv package first
try {
  require('dotenv').config({ path: envPath });
  envLoaded = true;
} catch (e) {
  // dotenv not installed, try loading .env manually
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const trimmedLine = line.trim();
      // Skip comments and empty lines
      if (trimmedLine && !trimmedLine.startsWith('#')) {
        const [key, ...valueParts] = trimmedLine.split('=');
        if (key && valueParts.length > 0) {
          const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
          if (!process.env[key.trim()]) {
            process.env[key.trim()] = value;
          }
        }
      }
    });
    envLoaded = true;
  }
}

if (!envLoaded) {
  console.warn(`⚠️  Warning: .env file not found at ${envPath}`);
  console.warn('   Make sure you have a .env file in the project root with AWS credentials.\n');
}

// Check for flags
const DRY_RUN = !process.argv.includes('--execute');
const CLEAN_TABLES = process.argv.includes('--clean');

const { S3Client, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
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
 * Sanitize name for S3 key (matches upload provider - lowercase with hyphens)
 */
function sanitizeName(name) {
  if (!name) return 'unknown';
  return name
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_.]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
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
 * Try common path variations to find the file
 */
async function tryPathVariations(baseKey, fileHash) {
  if (!baseKey) return null;
  
  // Extract filename from base key
  const fileName = baseKey.split('/').pop();
  const pathParts = baseKey.split('/').slice(0, -1);
  
  // Try different variations
  const variations = [
    // Original path
    baseKey,
    // Lowercase path
    baseKey.toLowerCase(),
    // Path with hyphens instead of underscores
    baseKey.replace(/_/g, '-'),
    // Path with hyphens and lowercase
    baseKey.toLowerCase().replace(/_/g, '-'),
    // Just filename at root (if file was uploaded without folder)
    fileName,
    // Filename with hash
    fileHash ? `${fileHash}${fileName.match(/\.[^.]+$/)?.[0] || ''}` : null,
  ].filter(Boolean);
  
  for (const variant of variations) {
    if (await fileExistsInS3(variant)) {
      return variant;
    }
  }
  
  return null;
}

/**
 * Find file in S3 by hash or filename (searches entire bucket - use sparingly)
 */
async function findFileInS3(fileHash, fileName) {
  try {
    // First try path variations
    if (fileHash) {
      const hashKey = `${fileHash}${fileName?.match(/\.[^.]+$/)?.[0] || ''}`;
      if (await fileExistsInS3(hashKey)) {
        return hashKey;
      }
    }
    
    // If not found, search by listing objects (this can be slow for large buckets)
    // Only search if we have a hash to narrow it down
    if (!fileHash) {
      console.log(`      ⚠️ No hash provided, skipping S3 search (would be too slow)`);
      return null;
    }
    
    console.log(`      🔍 Searching S3 bucket for file with hash: ${fileHash.substring(0, 8)}...`);
    
    let continuationToken = null;
    const maxResults = 1000;
    let checked = 0;
    
    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: config.s3.bucket,
        MaxKeys: maxResults,
        ContinuationToken: continuationToken,
      });
      
      const response = await s3Client.send(listCommand);
      
      if (response.Contents) {
        for (const object of response.Contents) {
          checked++;
          const key = object.Key;
          
          // Check if key contains the file hash
          if (fileHash && key.includes(fileHash)) {
            console.log(`      ✓ Found after checking ${checked} objects`);
            return key;
          }
        }
      }
      
      continuationToken = response.NextContinuationToken;
      
      // Limit search to avoid taking too long
      if (checked > 10000) {
        console.log(`      ⚠️ Searched ${checked} objects, stopping search`);
        break;
      }
    } while (continuationToken);
    
    return null;
  } catch (error) {
    console.error(`   Error searching S3 for file: ${error.message}`);
    return null;
  }
}

/**
 * Clean files_related tables - remove orphaned or duplicate entries
 */
async function cleanFilesRelatedTables(pool) {
  console.log('\n🧹 Cleaning files_related tables...\n');
  
  const tableNames = ['files_related_morphs', 'files_related_mph'];
  let cleanedCount = 0;
  
  for (const tableName of tableNames) {
    try {
      // Check if table exists
      const tableExists = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = $1
        )
      `, [tableName]);
      
      if (!tableExists.rows[0].exists) {
        console.log(`   ⏭️  Table ${tableName} does not exist, skipping`);
        continue;
      }
      
      console.log(`   🔍 Cleaning table: ${tableName}`);
      
      // Remove entries where file doesn't exist
      const orphanedResult = await pool.query(`
        DELETE FROM ${tableName} frm
        WHERE NOT EXISTS (
          SELECT 1 FROM files f WHERE f.id = frm.file_id
        )
      `);
      const orphanedCount = orphanedResult.rowCount || 0;
      
      // Remove entries where related entity doesn't exist (for lessons)
      const invalidRelatedResult = await pool.query(`
        DELETE FROM ${tableName} frm
        WHERE frm.related_type = 'api::lesson.lesson'
        AND NOT EXISTS (
          SELECT 1 FROM lessons l WHERE l.id = frm.related_id
        )
      `);
      const invalidRelatedCount = invalidRelatedResult.rowCount || 0;
      
      // Remove duplicate entries (keep only the first one)
      const duplicateResult = await pool.query(`
        DELETE FROM ${tableName} frm1
        WHERE frm1.id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY file_id, related_id, related_type, field 
              ORDER BY id
            ) as rn
            FROM ${tableName}
          ) t
          WHERE t.rn > 1
        )
      `);
      const duplicateCount = duplicateResult.rowCount || 0;
      
      const totalCleaned = orphanedCount + invalidRelatedCount + duplicateCount;
      cleanedCount += totalCleaned;
      
      console.log(`      ✓ Removed ${orphanedCount} orphaned file entries`);
      console.log(`      ✓ Removed ${invalidRelatedCount} invalid lesson relations`);
      console.log(`      ✓ Removed ${duplicateCount} duplicate entries`);
      console.log(`      ✓ Total cleaned from ${tableName}: ${totalCleaned}`);
      
    } catch (error) {
      console.log(`   ⚠️  Error cleaning ${tableName}: ${error.message}`);
    }
  }
  
  console.log(`\n   ✅ Cleanup complete. Total entries removed: ${cleanedCount}\n`);
  return cleanedCount;
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
  const missingVars = [];
  if (!config.s3.bucket) missingVars.push('AWS_BUCKET');
  if (!config.s3.region) missingVars.push('AWS_REGION');
  if (!config.s3.accessKeyId) missingVars.push('AWS_ACCESS_KEY_ID');
  if (!config.s3.secretAccessKey) missingVars.push('AWS_ACCESS_SECRET');
  
  if (missingVars.length > 0) {
    console.error('❌ Missing S3 configuration. The following environment variables are required:');
    missingVars.forEach(v => console.error(`   - ${v}`));
    console.error('\nPlease add these to your .env file in the project root directory.');
    console.error('Example .env file:');
    console.error('  AWS_REGION=us-east-1');
    console.error('  AWS_ACCESS_KEY_ID=your-access-key-id');
    console.error('  AWS_ACCESS_SECRET=your-secret-access-key');
    console.error('  AWS_BUCKET=your-bucket-name');
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
    // Clean tables if requested
    if (CLEAN_TABLES) {
      if (DRY_RUN) {
        console.log('🔍 [DRY RUN] Would clean files_related tables');
        console.log('   Use --execute --clean to actually clean tables\n');
      } else {
        await cleanFilesRelatedTables(pool);
      }
    }
    
    // Check which files_related table exists
    console.log('🔍 Checking database schema...');
    try {
      const tableCheck = await pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name LIKE 'files_related%'
      `);
      if (tableCheck.rows.length > 0) {
        console.log(`   Found tables: ${tableCheck.rows.map(r => r.table_name).join(', ')}`);
      } else {
        console.log('   ⚠️ No files_related tables found');
      }
    } catch (e) {
      console.log('   Could not check table schema:', e.message);
    }
    console.log('');

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
        // Query files linked to this lesson
        // Strapi uses different table names: files_related_morphs (v4) or files_related_mph (older)
        let fileLinksResult;
        const tableNames = ['files_related_morphs', 'files_related_mph'];
        let querySuccess = false;
        
        for (const tableName of tableNames) {
          try {
            fileLinksResult = await pool.query(`
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
              INNER JOIN ${tableName} frm ON f.id = frm.file_id
              WHERE frm.related_id = $1
                AND frm.related_type = 'api::lesson.lesson'
                AND frm.field = $2
            `, [lesson.lesson_id, fieldName]);
            querySuccess = true;
            break;
          } catch (e) {
            // Try next table name
            continue;
          }
        }
        
        if (!querySuccess) {
          console.log(`  ⚠️ Could not find files table. Tried: ${tableNames.join(', ')}`);
          console.log(`     This might mean no files are linked to this lesson via ${fieldName}`);
          continue;
        }

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

          // Fallback: try to find file in S3 by hash or filename
          if (!currentKey) {
            // Try hash + ext first
            const hashKey = `${file.file_hash}${file.file_ext}`;
            if (await fileExistsInS3(hashKey)) {
              currentKey = hashKey;
              console.log(`      ✓ Found file using hash: ${currentKey}`);
            } else {
              // Try to find by searching
              const foundKey = await findFileInS3(file.file_hash, file.file_name);
              if (foundKey) {
                currentKey = foundKey;
                console.log(`      ✓ Found file in S3: ${foundKey}`);
              } else {
                currentKey = hashKey;
                console.log(`      ⚠️ Could not find file in S3, using hash: ${currentKey}`);
              }
            }
          }

          // Build new key based on folder structure
          // Try to preserve the filename from current key if it exists, otherwise construct it
          let fileNamePart;
          if (currentKey && currentKey.includes('/')) {
            // Extract filename from current key (everything after last slash)
            fileNamePart = currentKey.split('/').pop();
          } else {
            // Construct filename matching upload provider format: name-hash.ext
            const fileName = file.file_name || file.file_hash || 'file';
            const fileExt = file.file_ext || '';
            const nameWithoutExt = fileName.replace(fileExt, '').replace(/\.[^.]*$/, '');
            const sanitizedFileName = sanitizeName(nameWithoutExt);
            const uniquePart = file.file_hash || 'file';
            fileNamePart = `${sanitizedFileName}-${uniquePart}${fileExt}`;
          }
          
          const newKey = `${courseName}/${moduleName}/${lessonName}/${fileNamePart}`;

          console.log(`      Current key: ${currentKey}`);
          console.log(`      New key: ${newKey}`);
          
          // Debug: Show what we're working with
          if (!currentKey || currentKey === `${file.file_hash}${file.file_ext}`) {
            console.log(`      ⚠️ Warning: Could not determine current S3 key from metadata or URL`);
            console.log(`         File hash: ${file.file_hash}`);
            console.log(`         File URL: ${file.file_url}`);
            console.log(`         Provider metadata: ${file.provider_metadata}`);
          }

          // Check if already in correct location
          if (currentKey === newKey) {
            console.log(`      ✓ Already in correct location`);
            totalFilesSkipped++;
            continue;
          }

          // If source file not found at current key, try path variations first
          const sourceExists = await fileExistsInS3(currentKey);
          if (!sourceExists) {
            console.log(`      🔍 File not found at current key, trying path variations...`);
            
            // Try path variations (faster than full search)
            const variantKey = await tryPathVariations(currentKey, file.file_hash);
            if (variantKey) {
              console.log(`      ✓ Found file at variant path: ${variantKey}`);
              currentKey = variantKey;
            } else if (file.file_hash) {
              // If variations don't work, try full search
              console.log(`      🔍 Trying full S3 search...`);
              const foundKey = await findFileInS3(file.file_hash, file.file_name);
              if (foundKey) {
                console.log(`      ✓ Found file at different location: ${foundKey}`);
                currentKey = foundKey;
              }
            }
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
    
    // Auto-clean tables after successful reorganization (if not already cleaned)
    if (!DRY_RUN && !CLEAN_TABLES && totalFilesMoved > 0) {
      console.log('\n🧹 Auto-cleaning files_related tables after reorganization...');
      await cleanFilesRelatedTables(pool);
    }
    
    if (DRY_RUN && totalFilesMoved > 0) {
      console.log('\n  To actually move files, run:');
      console.log('  node scripts/reorganize-files.js --execute\n');
      console.log('  💡 Tip: Add --clean flag to also clean files_related tables:');
      console.log('  node scripts/reorganize-files.js --execute --clean\n');
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
