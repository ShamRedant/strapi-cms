'use strict';

const { S3Client, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

/**
 * Sanitize name for S3 key
 */
function sanitizeName(name) {
  if (!name) return 'unknown';
  return name
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_.]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Reorganize all files for a lesson to the correct S3 folder structure
 * Called after lesson is created or updated
 */
async function reorganizeLessonFiles(lessonId, strapiInstance) {
  // Use provided strapi instance or fall back to global
  const strapi = strapiInstance || global.strapi;
  
  if (!strapi) {
    console.error('❌ Strapi instance not available');
    return;
  }

  try {
    console.log(`\n🔄 Reorganizing files for lesson: ${lessonId}`);

    // Fetch lesson with module and course
    const lesson = await strapi.entityService.findOne(
      'api::lesson.lesson',
      lessonId,
      {
        populate: {
          module: {
            populate: ['course']
          },
          teacher_file: true,
          student_file: true,
          homework_file: true,
          ppt_file: true,
        }
      }
    );

    if (!lesson) {
      console.log('Lesson not found:', lessonId);
      return;
    }

    // Check if lesson has module and course
    if (!lesson.module || !lesson.module.course) {
      console.log('⚠️ Lesson does not have module or course, skipping reorganization');
      return;
    }

    // Build the folder path
    const courseTitle = lesson.module.course.course_title || 
                       lesson.module.course.title || 
                       'Uncategorized';
    const moduleTitle = lesson.module.title || 'Module';
    const lessonTitle = lesson.title || 'Lesson';

    const courseName = sanitizeName(courseTitle);
    const moduleName = sanitizeName(moduleTitle);
    const lessonName = sanitizeName(lessonTitle);

    const targetFolder = `${courseName}/${moduleName}/${lessonName}`;

    console.log(`Target folder: ${targetFolder}`);
    console.log(`Course: ${courseTitle}`);
    console.log(`Module: ${moduleTitle}`);
    console.log(`Lesson: ${lessonTitle}`);

    // Get S3 configuration
    const uploadConfig = strapi.config.get('plugin.upload');
    const providerOptions = uploadConfig?.providerOptions || {};
    
    const bucket = providerOptions.params?.Bucket;
    const region = providerOptions.region || providerOptions.s3Options?.region;

    if (!bucket || !region) {
      console.error('❌ S3 bucket or region not configured');
      return;
    }

    // Create S3 client
    const s3Client = new S3Client({
      region: region,
      credentials: {
        accessKeyId: providerOptions.accessKeyId || providerOptions.s3Options?.credentials?.accessKeyId,
        secretAccessKey: providerOptions.secretAccessKey || providerOptions.s3Options?.credentials?.secretAccessKey,
      },
    });

    // File fields to check
    const fileFields = [
      { field: 'teacher_file', file: lesson.teacher_file },
      { field: 'student_file', file: lesson.student_file },
      { field: 'homework_file', file: lesson.homework_file },
      { field: 'ppt_file', file: lesson.ppt_file },
    ];

    let filesProcessed = 0;
    let filesMoved = 0;
    let filesSkipped = 0;

    // Process each file field
    for (const { field, file } of fileFields) {
      if (!file) continue;

      // Handle both single file and array of files
      const files = Array.isArray(file) ? file : [file];

      for (const fileItem of files) {
        if (!fileItem || !fileItem.id) continue;

        filesProcessed++;

        // Get current S3 key from provider_metadata
        let currentKey = null;
        if (fileItem.provider_metadata) {
          try {
            const metadata = typeof fileItem.provider_metadata === 'string' 
              ? JSON.parse(fileItem.provider_metadata) 
              : fileItem.provider_metadata;
            currentKey = metadata.key;
          } catch (e) {
            // Ignore parse error
          }
        }

        // If no key in metadata, try to extract from URL
        if (!currentKey && fileItem.url) {
          const urlMatch = fileItem.url.match(/\.amazonaws\.com\/(.+)$/);
          if (urlMatch) {
            currentKey = decodeURIComponent(urlMatch[1]);
          }
        }

        // Fallback to hash + ext
        if (!currentKey) {
          currentKey = `${fileItem.hash}${fileItem.ext || ''}`;
        }

        // Build new key based on folder structure
        const fileName = fileItem.name || fileItem.hash || 'file';
        const fileExt = fileItem.ext || '';
        const newKey = `${targetFolder}/${fileName}${fileExt}`;

        console.log(`\n  📄 File: ${fileName} (${field})`);
        console.log(`     Current: ${currentKey}`);
        console.log(`     New: ${newKey}`);

        // Check if already in correct location
        if (currentKey === newKey) {
          console.log(`     ✓ Already in correct location`);
          filesSkipped++;
          continue;
        }

        // Check if source file exists in S3
        const sourceExists = await fileExistsInS3(s3Client, bucket, currentKey);
        if (!sourceExists) {
          console.log(`     ⚠️ Source file not found in S3: ${currentKey}`);
          filesSkipped++;
          continue;
        }

        // Check if destination already exists
        const destExists = await fileExistsInS3(s3Client, bucket, newKey);
        if (destExists) {
          console.log(`     ℹ️ Destination already exists: ${newKey}`);
          // Delete old file if different from new
          if (currentKey !== newKey) {
            await deleteFileFromS3(s3Client, bucket, currentKey);
            console.log(`     ✓ Deleted old file: ${currentKey}`);
          }
          filesSkipped++;
          continue;
        }

        // Move file in S3
        try {
          await moveFileInS3(s3Client, bucket, currentKey, newKey, fileItem.mime || 'application/octet-stream');
          
          // Update file record in database
          const newUrl = `https://${bucket}.s3.${region}.amazonaws.com/${newKey}`;
          const newMetadata = JSON.stringify({ key: newKey, bucket: bucket });

          await strapi.db.query('plugin::upload.file').update({
            where: { id: fileItem.id },
            data: {
              url: newUrl,
              provider_metadata: newMetadata,
            },
          });

          console.log(`     ✓ Moved and updated successfully`);
          console.log(`\n📋 FINAL DATABASE PATH AFTER REORGANIZATION:`);
          console.log(`   ╔═══════════════════════════════════════════════════════════════════╗`);
          console.log(`   ║ File ID: ${String(fileItem.id).padEnd(54)} ║`);
          console.log(`   ║ File Name: ${(fileItem.name || 'N/A').padEnd(53)} ║`);
          console.log(`   ╠═══════════════════════════════════════════════════════════════════╣`);
          console.log(`   ║ S3 Key Path (provider_metadata.key):                             ║`);
          console.log(`   ║ ${newKey.padEnd(63)} ║`);
          console.log(`   ╠═══════════════════════════════════════════════════════════════════╣`);
          console.log(`   ║ Full URL (url field):                                            ║`);
          console.log(`   ║ ${newUrl.padEnd(63)} ║`);
          console.log(`   ╠═══════════════════════════════════════════════════════════════════╣`);
          console.log(`   ║ Bucket (provider_metadata.bucket):                              ║`);
          console.log(`   ║ ${bucket.padEnd(63)} ║`);
          console.log(`   ╚═══════════════════════════════════════════════════════════════════╝\n`);
          filesMoved++;
        } catch (error) {
          console.error(`     ❌ Error moving file: ${error.message}`);
        }
      }
    }

    console.log(`\n✅ Reorganization complete!`);
    console.log(`   Files processed: ${filesProcessed}`);
    console.log(`   Files moved: ${filesMoved}`);
    console.log(`   Files skipped: ${filesSkipped}\n`);

  } catch (error) {
    console.error('❌ Error reorganizing lesson files:', error);
    console.error('Error stack:', error.stack);
  }
}

/**
 * Check if file exists in S3
 */
async function fileExistsInS3(s3Client, bucket, key) {
  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: bucket,
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
 * Delete file from S3
 */
async function deleteFileFromS3(s3Client, bucket, key) {
  await s3Client.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
}

/**
 * Move file in S3 from old location to new location
 */
async function moveFileInS3(s3Client, bucket, oldKey, newKey, contentType) {
  // Copy to new location
  await s3Client.send(new CopyObjectCommand({
    Bucket: bucket,
    CopySource: `${bucket}/${encodeURIComponent(oldKey)}`,
    Key: newKey,
    ContentType: contentType,
    MetadataDirective: 'REPLACE',
  }));

  // Delete old file
  await s3Client.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: oldKey,
  }));
}

module.exports = {
  reorganizeLessonFiles,
};

