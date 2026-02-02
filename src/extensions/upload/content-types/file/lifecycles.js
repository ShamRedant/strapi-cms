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
    
    // Wait a moment for relations to be established
    setTimeout(async () => {
      await reorganizeFileIfNeeded(result.id);
    }, 1000);
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
    
    // Check if file is related to any lessons
    if (!file.related || file.related.length === 0) {
      console.log('No relations found, skipping reorganization');
      return;
    }
    
    // Find lesson relations
    for (const relation of file.related) {
      // Check if this is a lesson relation
      if (relation.__component === 'api::lesson.lesson' || 
          relation.__type === 'api::lesson.lesson' ||
          relation.__pivot?.related_type === 'api::lesson.lesson') {
        
        console.log('✓ Found lesson relation!');
        
        // Get the lesson ID
        const lessonId = relation.id || relation.documentId;
        
        if (!lessonId) {
          console.log('Could not determine lesson ID');
          continue;
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