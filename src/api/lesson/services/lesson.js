/**
 * Lesson Service
 * File: src/api/lesson/services/lesson.js
 * 
 * Custom service to handle lesson file uploads with proper folder structure
 */

'use strict';

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::lesson.lesson', ({ strapi }) => ({
  /**
   * Custom create with file handling
   */
  async create(params) {
    const { data, files } = params;

    console.log('Lesson service create called');

    // First, create the lesson without files
    const lesson = await strapi.entityService.create('api::lesson.lesson', {
      data: {
        ...data,
        // Exclude file fields
        teacher_file: undefined,
        student_file: undefined,
        homework_file: undefined,
        ppt_file: undefined,
      },
      populate: {
        module: {
          populate: ['course']
        }
      }
    });

    console.log('Lesson created with ID:', lesson.id);

    // Now upload files if present
    if (files) {
      const fileFields = ['teacher_file', 'student_file', 'homework_file', 'ppt_file'];
      const uploadedFiles = {};

      for (const field of fileFields) {
        if (files[field]) {
          console.log(`Uploading ${field}...`);
          
          // Attach lesson context to file
          const file = files[field];
          file.related = [{
            id: lesson.id,
            __type: 'api::lesson.lesson',
            __pivot: { field }
          }];
          file.field = field;

          // Upload using Strapi's upload service
          const uploadedFile = await strapi.plugins.upload.services.upload.upload({
            data: {
              refId: lesson.id,
              ref: 'api::lesson.lesson',
              field: field,
            },
            files: file,
          });

          uploadedFiles[field] = uploadedFile[0].id;
          console.log(`✓ Uploaded ${field}`);
        }
      }

      // Update lesson with file references
      if (Object.keys(uploadedFiles).length > 0) {
        await strapi.entityService.update('api::lesson.lesson', lesson.id, {
          data: uploadedFiles,
        });
        console.log('Lesson updated with file references');
      }
    }

    // Return the complete lesson
    return await strapi.entityService.findOne('api::lesson.lesson', lesson.id, {
      populate: {
        module: {
          populate: ['course']
        },
        teacher_file: true,
        student_file: true,
        homework_file: true,
        ppt_file: true,
      }
    });
  },

  /**
   * Custom update with file handling
   */
  async update(lessonId, params) {
    const { data, files } = params;

    console.log('Lesson service update called for:', lessonId);

    // Update lesson data (excluding files)
    const lesson = await strapi.entityService.update('api::lesson.lesson', lessonId, {
      data: {
        ...data,
        // Exclude file fields
        teacher_file: undefined,
        student_file: undefined,
        homework_file: undefined,
        ppt_file: undefined,
      },
      populate: {
        module: {
          populate: ['course']
        },
        teacher_file: true,
        student_file: true,
        homework_file: true,
        ppt_file: true,
      }
    });

    // Handle file uploads
    if (files) {
      const fileFields = ['teacher_file', 'student_file', 'homework_file', 'ppt_file'];
      const uploadedFiles = {};

      for (const field of fileFields) {
        if (files[field]) {
          console.log(`Uploading ${field}...`);

          // Delete old file if exists
          if (lesson[field]) {
            await strapi.plugins.upload.services.upload.remove(lesson[field]);
            console.log(`✓ Deleted old ${field}`);
          }

          // Attach lesson context to file
          const file = files[field];
          file.related = [{
            id: lessonId,
            __type: 'api::lesson.lesson',
            __pivot: { field }
          }];
          file.field = field;

          // Upload new file
          const uploadedFile = await strapi.plugins.upload.services.upload.upload({
            data: {
              refId: lessonId,
              ref: 'api::lesson.lesson',
              field: field,
            },
            files: file,
          });

          uploadedFiles[field] = uploadedFile[0].id;
          console.log(`✓ Uploaded new ${field}`);
        }
      }

      // Update lesson with new file references
      if (Object.keys(uploadedFiles).length > 0) {
        await strapi.entityService.update('api::lesson.lesson', lessonId, {
          data: uploadedFiles,
        });
      }
    }

    // Return updated lesson
    return await strapi.entityService.findOne('api::lesson.lesson', lessonId, {
      populate: {
        module: {
          populate: ['course']
        },
        teacher_file: true,
        student_file: true,
        homework_file: true,
        ppt_file: true,
      }
    });
  },

  /**
   * Custom delete with file cleanup
   */
  async delete(lessonId) {
    console.log('Lesson service delete called for:', lessonId);

    // Get lesson with files
    const lesson = await strapi.entityService.findOne('api::lesson.lesson', lessonId, {
      populate: {
        teacher_file: true,
        student_file: true,
        homework_file: true,
        ppt_file: true,
      }
    });

    // Delete files
    const fileFields = ['teacher_file', 'student_file', 'homework_file', 'ppt_file'];
    for (const field of fileFields) {
      if (lesson[field]) {
        await strapi.plugins.upload.services.upload.remove(lesson[field]);
        console.log(`✓ Deleted ${field}`);
      }
    }

    // Delete lesson
    return await strapi.entityService.delete('api::lesson.lesson', lessonId);
  },
}));