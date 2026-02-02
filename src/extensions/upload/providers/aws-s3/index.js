/**
 * Extended AWS S3 Provider
 * File: src/extensions/upload/providers/aws-s3/index.js
 * 
 * This extends the default AWS S3 provider to add folder structure support
 */

'use strict';

const AWS = require('aws-sdk');
const path = require('path');
const { getNextFileContext } = require('../utils/upload-context');

/**
 * Sanitize folder/file names
 */
const sanitize = (name) => {
  if (!name) return '';
  return name
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_.]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
};

/**
 * Get folder path from file context
 */
const getFolderPath = async (file, strapi) => {
  try {
    // Check if file has related entity (lesson)
    if (!file.related || file.related.length === 0) {
      console.log('No related entity, using default path');
      return 'uncategorized';
    }

    const relation = file.related[0];
    const { id, __type } = relation;

    console.log('File relation:', { id, type: __type, field: file.field });

    // Only process lesson files
    if (!__type || !__type.includes('lesson')) {
      return 'uncategorized';
    }

    // Extract lesson ID
    const lessonId = id;

    // Fetch lesson with module and course
    const lesson = await strapi.entityService.findOne(
      'api::lesson.lesson',
      lessonId,
      {
        populate: {
          module: {
            populate: ['course']
          }
        }
      }
    );

    if (!lesson) {
      console.warn('Lesson not found:', lessonId);
      return 'uncategorized';
    }

    // Get course title
    const courseTitle = lesson.module?.course?.title || 
                       lesson.module?.course?.course_title || 
                       'unknown-course';
    
    // Get module title
    const moduleTitle = lesson.module?.title || 'unknown-module';
    
    // Get lesson title
    const lessonTitle = lesson.title || 'unknown-lesson';

    // Build folder path
    const folderPath = [
      sanitize(courseTitle),
      sanitize(moduleTitle),
      sanitize(lessonTitle)
    ].join('/');

    console.log('Generated folder path:', folderPath);
    return folderPath;

  } catch (error) {
    console.error('Error getting folder path:', error);
    return 'uncategorized';
  }
};

/**
 * Generate file name without hash
 */
const generateFileName = (file) => {
  const ext = path.extname(file.name);
  const nameWithoutExt = path.basename(file.name, ext);
  const cleanName = sanitize(nameWithoutExt);
  
  // Add timestamp to prevent conflicts
  const timestamp = Date.now();
  return `${cleanName}-${timestamp}${ext}`;
};

module.exports = {
  init(config) {
    const s3 = new AWS.S3({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      ...config.s3Options,
    });

    const bucket = config.params.Bucket;

    return {
      /**
       * Upload file to S3 with folder structure
       */
      async upload(file, customParams = {}) {
        try {
          // Get folder path - prefer context from upload service (lesson path)
          let key;
          const fileContext = getNextFileContext();
          if (fileContext && fileContext.path) {
            const ext = path.extname(file.name || file.originalFilename || '') || '.bin';
            const uniquePart = file.hash ? file.hash : `file-${Date.now()}`;
            const fileName = `${fileContext.fileName}-${uniquePart}${ext}`;
            key = `${fileContext.path}/${fileName}`;
            console.log('Using lesson path from upload context:', key);
          } else {
            const folderPath = await getFolderPath(file, strapi);
            const fileName = generateFileName(file);
            key = `${folderPath}/${fileName}`;
          }
          
          console.log(`Uploading to S3: ${key}`);

          // Upload to S3
          const uploadParams = {
            Bucket: bucket,
            Key: key,
            Body: file.stream || Buffer.from(file.buffer, 'binary'),
            ContentType: file.mime,
            ...config.params,
            ...customParams,
          };

          const result = await s3.upload(uploadParams).promise();

          // Update file object
          file.url = result.Location;
          file.provider_metadata = {
            key: result.Key,
            bucket: bucket,
            etag: result.ETag,
          };

          console.log(`✓ Uploaded: ${result.Location}`);
          
        } catch (error) {
          console.error('S3 upload error:', error);
          throw new Error(`Upload failed: ${error.message}`);
        }
      },

      /**
       * Upload file stream to S3 with folder structure
       */
      async uploadStream(file, customParams = {}) {
        try {
          // Get folder path - prefer context from upload service (lesson path)
          let key;
          const fileContext = getNextFileContext();
          if (fileContext && fileContext.path) {
            const ext = path.extname(file.name || file.originalFilename || '') || '.bin';
            const uniquePart = file.hash ? file.hash : `file-${Date.now()}`;
            const fileName = `${fileContext.fileName}-${uniquePart}${ext}`;
            key = `${fileContext.path}/${fileName}`;
            console.log('Using lesson path from upload context (stream):', key);
          } else {
            const folderPath = await getFolderPath(file, strapi);
            const fileName = generateFileName(file);
            key = `${folderPath}/${fileName}`;
          }
          
          console.log(`Uploading stream to S3: ${key}`);

          const uploadParams = {
            Bucket: bucket,
            Key: key,
            Body: file.stream,
            ContentType: file.mime,
            ...config.params,
            ...customParams,
          };

          const result = await s3.upload(uploadParams).promise();

          file.url = result.Location;
          file.provider_metadata = {
            key: result.Key,
            bucket: bucket,
            etag: result.ETag,
          };

          console.log(`✓ Uploaded stream: ${result.Location}`);
          
        } catch (error) {
          console.error('S3 upload stream error:', error);
          throw new Error(`Upload stream failed: ${error.message}`);
        }
      },

      /**
       * Delete file from S3
       */
      async delete(file, customParams = {}) {
        try {
          const key = file.provider_metadata?.key || file.hash;
          
          await s3
            .deleteObject({
              Bucket: bucket,
              Key: key,
              ...customParams,
            })
            .promise();

          console.log(`✓ Deleted: ${key}`);
        } catch (error) {
          console.error('S3 delete error:', error);
          throw new Error(`Delete failed: ${error.message}`);
        }
      },

      /**
       * Check if file exists in S3
       */
      async checkFileSize(file, customParams = {}) {
        try {
          const key = file.provider_metadata?.key || file.hash;
          
          const { ContentLength } = await s3
            .headObject({
              Bucket: bucket,
              Key: key,
              ...customParams,
            })
            .promise();

          return ContentLength;
        } catch (error) {
          if (error.code === 'NotFound') {
            return null;
          }
          console.error('S3 check file size error:', error);
          throw new Error(`Check file size failed: ${error.message}`);
        }
      },

      /**
       * Get signed URL for private files
       */
      async getSignedUrl(file, customParams = {}) {
        try {
          const key = file.provider_metadata?.key || file.hash;
          
          const url = s3.getSignedUrl('getObject', {
            Bucket: bucket,
            Key: key,
            Expires: 15 * 60, // 15 minutes
            ...customParams,
          });

          return { url };
        } catch (error) {
          console.error('S3 get signed URL error:', error);
          throw new Error(`Get signed URL failed: ${error.message}`);
        }
      },

      /**
       * Check if file is private
       */
      isPrivate() {
        return config.params.ACL === 'private';
      },
    };
  },
};