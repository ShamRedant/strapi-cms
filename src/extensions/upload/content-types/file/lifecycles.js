'use strict';

const { S3Client, CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

/**
 * File Lifecycle Hook
 * This runs when files are created/updated in the upload plugin
 * It reorganizes files into proper S3 folders when they're attached to lessons
 */
module.exports = {
  
  /**
   * After a file is created, check if it needs reorganization
   */
  async afterCreate(event) {
    const { result } = event;
    
    console.log('\n=== FILE CREATED ===');
    console.log('File ID:', result.id);
    console.log('File name:', result.name);
    console.log('Checking for lesson relations...');
    
    // Wait a moment for relations to be established, then check and link
    setTimeout(async () => {
      await reorganizeFileIfNeeded(result.id);
    }, 2000); // Increased delay to ensure relations are saved
  },
  
  /**
   * After a file is updated (e.g., attached to a lesson), reorganize if needed
   */
  async afterUpdate(event) {
    const { result } = event;
    
    console.log('\n=== FILE UPDATED ===');
    console.log('File ID:', result.id);
    console.log('File name:', result.name);
    
    await reorganizeFileIfNeeded(result.id);
  },
};

/**
 * Check if file is attached to a lesson and reorganize to proper S3 folder
 */
async function reorganizeFileIfNeeded(fileId) {
  try {
    let lessonId = null;
    let fieldName = null;
    
    // Fetch the file with all its relations
    const file = await strapi.db.query('plugin::upload.file').findOne({
      where: { id: fileId },
      populate: ['related'],
    });
    
    if (!file) {
      console.log('File not found');
      return;
    }
    
    console.log('File has', file.related?.length || 0, 'relations');
    console.log('File relations:', JSON.stringify(file.related, null, 2));
    
    // Try to get lesson info from relations
    if (file.related && file.related.length > 0) {
      for (const relation of file.related) {
        console.log('Checking relation:', JSON.stringify(relation, null, 2));
        
        // Check various ways a lesson relation might be stored
        const isLessonRelation = 
          relation.__component === 'api::lesson.lesson' || 
          relation.__type === 'api::lesson.lesson' ||
          relation.__pivot?.related_type === 'api::lesson.lesson' ||
          (relation.__pivot && typeof relation.__pivot === 'object' && 'field' in relation.__pivot);
        
        if (isLessonRelation) {
          lessonId = relation.id || relation.documentId || relation.related_id;
          fieldName = relation.__pivot?.field || relation.field;
          console.log(`✓ Found lesson relation: lessonId=${lessonId}, field=${fieldName}`);
          break;
        }
      }
    }
    
    // Also try querying the morph table using Strapi's query builder
    if (!lessonId) {
      try {
        // Get the database connection
        const db = strapi.db;
        const connection = db.connection;
        
        // Try to find in morph table - table name varies by Strapi version
        const tableNames = ['files_related_morphs', 'files_related_mph'];
        
        for (const tableName of tableNames) {
          try {
            const result = await connection(tableName)
              .where('file_id', fileId)
              .where('related_type', 'api::lesson.lesson')
              .first(['related_id', 'field']);
            
            if (result) {
              lessonId = result.related_id;
              fieldName = result.field;
              console.log(`📋 Found lesson relation in ${tableName}: lessonId=${lessonId}, field=${fieldName}`);
              break;
            }
          } catch (tableError) {
            // Table doesn't exist, try next
            continue;
          }
        }
      } catch (dbError) {
        console.log('Could not query morph table:', dbError.message);
      }
    }
    
    // If we still don't have lesson info, skip
    if (!lessonId) {
      console.log('No lesson relation found, skipping reorganization and linking');
      return;
    }
    
    // Link file to lesson's field if field name is provided
    if (fieldName && ['teacher_file', 'student_file', 'homework_file', 'ppt_file'].includes(fieldName)) {
      try {
        console.log(`🔗 Linking file ${file.id} to lesson ${lessonId} field: ${fieldName}`);
        
        // Check current lesson state
        const currentLesson = await strapi.entityService.findOne('api::lesson.lesson', lessonId, {
          fields: ['id', fieldName],
        });
        
        if (!currentLesson) {
          console.log(`⚠️ Lesson ${lessonId} not found`);
          return;
        }
        
        // Check if file is already linked (compare IDs)
        const currentFileId = currentLesson[fieldName]?.id || currentLesson[fieldName];
        if (currentFileId !== file.id) {
          try {
            // Use entityService.update - this is the correct way to update media relations
            await strapi.entityService.update('api::lesson.lesson', lessonId, {
              data: {
                [fieldName]: file.id,
              },
            });
            
            console.log(`✅ File ${file.id} linked to lesson ${lessonId}.${fieldName}`);
          } catch (updateError) {
            console.error(`❌ Error updating lesson ${lessonId}.${fieldName}:`, updateError.message);
            console.error(`   Error details:`, updateError);
          }
        } else {
          console.log(`✓ File already linked to lesson ${lessonId}.${fieldName}`);
        }
      } catch (linkError) {
        console.error(`❌ Error linking file to lesson field:`, linkError);
        console.error('Error details:', linkError.message);
        if (linkError.stack) {
          console.error('Stack:', linkError.stack);
        }
      }
    } else {
      console.log(`⚠️ Field name '${fieldName}' is not a valid lesson file field`);
    }
        
        // Fetch lesson with module and course
        const lesson = await strapi.entityService.findOne(
          'api::lesson.lesson',
          lessonId,
          {
            populate: {
              module: {
                populate: ['course'],
              },
            },
          }
        );
        
        if (!lesson) {
          console.log('Lesson not found:', lessonId);
          continue;
        }
        
        console.log('Lesson found:', lesson.title);
        console.log('Module:', lesson.module?.title);
        console.log('Course:', lesson.module?.course?.course_title);
        
        // Check if lesson has module and course
        if (!lesson.module || !lesson.module.course) {
          console.log('⚠️ Lesson does not have module or course, skipping');
          continue;
        }
        
        // Build the new S3 path
        const courseName = sanitizeName(
          lesson.module.course.course_title || 
          lesson.module.course.title || 
          'Uncategorized'
        );
        const moduleName = sanitizeName(lesson.module.title || 'Module');
        const lessonTitle = sanitizeName(lesson.title || 'lesson');
        
        const newKey = `${courseName}/${moduleName}/${lessonTitle}${file.ext}`;
        const oldKey = file.provider_metadata?.key || file.key || `${file.hash}${file.ext}`;
        
        console.log('Old S3 key:', oldKey);
        console.log('New S3 key:', newKey);
        
        // If keys are the same, no need to reorganize
        if (newKey === oldKey) {
          console.log('✓ File already in correct location');
          return;
        }
        
        // Reorganize the file
        await reorganizeFileInS3(file, oldKey, newKey);
        
        // Only process the first lesson relation
        break;
      }
    }
    
  } catch (error) {
    console.error('Error in reorganizeFileIfNeeded:', error);
  }
}

/**
 * Move file in S3 from old location to new location
 */
async function reorganizeFileInS3(file, oldKey, newKey) {
  try {
    console.log('\n🔄 Reorganizing file in S3...');
    
    // Get S3 configuration from plugin config
    const uploadConfig = strapi.config.get('plugin.upload');
    const providerOptions = uploadConfig?.providerOptions || {};
    
    const bucket = providerOptions.params?.Bucket;
    const region = providerOptions.region;
    
    if (!bucket || !region) {
      console.error('❌ S3 bucket or region not configured');
      return;
    }
    
    console.log('S3 Bucket:', bucket);
    console.log('S3 Region:', region);
    
    // Create S3 client
    const s3Client = new S3Client({
      region: region,
      credentials: {
        accessKeyId: providerOptions.accessKeyId,
        secretAccessKey: providerOptions.secretAccessKey,
      },
    });
    
    // Step 1: Copy file to new location
    console.log('Copying file to new location...');
    
    const copyCommand = new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${oldKey}`,
      Key: newKey,
      ACL: providerOptions.params?.ACL || 'public-read',
      ContentType: file.mime,
      MetadataDirective: 'REPLACE',
    });
    
    await s3Client.send(copyCommand);
    console.log('✓ File copied successfully');
    
    // Step 2: Delete old file
    console.log('Deleting old file...');
    
    const deleteCommand = new DeleteObjectCommand({
      Bucket: bucket,
      Key: oldKey,
    });
    
    await s3Client.send(deleteCommand);
    console.log('✓ Old file deleted successfully');
    
    // Step 3: Update file record in database
    const newUrl = `https://${bucket}.s3.${region}.amazonaws.com/${newKey}`;
    
    console.log('Updating file record in database...');
    console.log('New URL:', newUrl);
    
    await strapi.db.query('plugin::upload.file').update({
      where: { id: file.id },
      data: {
        url: newUrl,
        provider_metadata: { key: newKey },
        key: newKey,
      },
    });
    
    console.log('✓ File record updated');
    console.log('✅ File reorganization complete!\n');
    
  } catch (error) {
    console.error('❌ Error reorganizing file in S3:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      name: error.name,
    });
  }
}

/**
 * Sanitize name for S3 key
 */
function sanitizeName(name) {
  return name
    .toString()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    || 'file';
}