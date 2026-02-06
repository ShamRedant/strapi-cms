/**
 * Lesson Controller
 * File: src/api/lesson/controllers/lesson.js
 * 
 * Custom controller that uses the lesson service for proper file handling
 */

'use strict';

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::lesson.lesson', ({ strapi }) => ({
  /**
   * Create a lesson with files
   */
  async create(ctx) {
    try {
      const { data } = ctx.request.body;
      const files = ctx.request.files;

      console.log('Controller create called');
      console.log('Data:', data);
      console.log('Files:', Object.keys(files || {}));

      // Parse data if it's a string (multipart form data)
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;

      // Use custom service
      const entity = await strapi.service('api::lesson.lesson').create({
        data: parsedData,
        files: files,
      });

      // Sanitize output
      const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
      
      return this.transformResponse(sanitizedEntity);
    } catch (error) {
      console.error('Error in lesson create:', error);
      ctx.throw(400, error.message);
    }
  },

  /**
   * Update a lesson with files
   */
  async update(ctx) {
    try {
      const { id } = ctx.params;
      const { data } = ctx.request.body;
      const files = ctx.request.files;

      console.log('Controller update called for:', id);
      console.log('Files:', Object.keys(files || {}));

      // Parse data if it's a string
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;

      // Use custom service
      const entity = await strapi.service('api::lesson.lesson').update(id, {
        data: parsedData,
        files: files,
      });

      // Sanitize output
      const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
      
      return this.transformResponse(sanitizedEntity);
    } catch (error) {
      console.error('Error in lesson update:', error);
      ctx.throw(400, error.message);
    }
  },

  /**
   * Delete a lesson with files
   */
  async delete(ctx) {
    try {
      const { id } = ctx.params;

      console.log('Controller delete called for:', id);

      // Use custom service
      const entity = await strapi.service('api::lesson.lesson').delete(id);

      // Sanitize output
      const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
      
      return this.transformResponse(sanitizedEntity);
    } catch (error) {
      console.error('Error in lesson delete:', error);
      ctx.throw(400, error.message);
    }
  },

  /**
   * Find lessons (override to populate properly)
   */
  async find(ctx) {
    // Ensure proper population - handle both missing populate and populate=*
    const populateValue = ctx.query.populate;
    
    console.log('🔍 Original populate value:', populateValue, 'Type:', typeof populateValue);
    
    // Handle populate=* (comes as string "*" from query params)
    if (!populateValue || populateValue === '*' || populateValue === 'true' || (typeof populateValue === 'string' && populateValue.includes('*'))) {
      // Set explicit populate to ensure files are included
      ctx.query.populate = {
        module: {
          populate: ['course']
        },
        teacher_file: true,
        student_file: true,
        homework_file: true,
        ppt_file: true,
      };
      console.log('✅ Using explicit populate for files');
    } else if (typeof populateValue === 'object') {
      // If populate is already an object, ensure file fields are included
      ctx.query.populate = {
        ...populateValue,
        module: populateValue.module || {
          populate: ['course']
        },
        teacher_file: populateValue.teacher_file !== false ? true : false,
        student_file: populateValue.student_file !== false ? true : false,
        homework_file: populateValue.homework_file !== false ? true : false,
        ppt_file: populateValue.ppt_file !== false ? true : false,
      };
      console.log('✅ Merged populate with file fields');
    } else {
      // If it's a string but not '*', still ensure files are populated
      ctx.query.populate = {
        module: {
          populate: ['course']
        },
        teacher_file: true,
        student_file: true,
        homework_file: true,
        ppt_file: true,
      };
      console.log('✅ Defaulting to explicit populate');
    }

    console.log('🔍 Final populate config:', JSON.stringify(ctx.query.populate, null, 2));
    
    const result = await super.find(ctx);
    
    // Debug: Check if files are populated for specific lessons
    if (result?.data && Array.isArray(result.data)) {
      const debugLessonIds = [49, 67, 69, 120]; // Add lesson IDs to debug
      result.data.forEach((lesson) => {
        if (debugLessonIds.includes(lesson.id)) {
          console.log(`\n📋 Lesson ${lesson.id} (${lesson.title}) file status:`);
          console.log(`   student_file: ${lesson.student_file ? (typeof lesson.student_file === 'object' ? `ID ${lesson.student_file.id}` : `ID ${lesson.student_file}`) : 'null'}`);
          console.log(`   teacher_file: ${lesson.teacher_file ? (typeof lesson.teacher_file === 'object' ? `ID ${lesson.teacher_file.id}` : `ID ${lesson.teacher_file}`) : 'null'}`);
          console.log(`   homework_file: ${lesson.homework_file ? (typeof lesson.homework_file === 'object' ? `ID ${lesson.homework_file.id}` : `ID ${lesson.homework_file}`) : 'null'}`);
          console.log(`   ppt_file: ${lesson.ppt_file ? (typeof lesson.ppt_file === 'object' ? `ID ${lesson.ppt_file.id}` : `ID ${lesson.ppt_file}`) : 'null'}`);
          
          // Also verify database state directly
          strapi.db.query('api::lesson.lesson').findOne({
            where: { id: lesson.id },
            select: ['id', 'student_file', 'teacher_file', 'homework_file', 'ppt_file'],
          }).then((dbLesson) => {
            console.log(`   🔍 Database check for lesson ${lesson.id}:`);
            console.log(`      student_file in DB: ${dbLesson?.student_file || 'null'}`);
            console.log(`      teacher_file in DB: ${dbLesson?.teacher_file || 'null'}`);
            console.log(`      homework_file in DB: ${dbLesson?.homework_file || 'null'}`);
            console.log(`      ppt_file in DB: ${dbLesson?.ppt_file || 'null'}`);
          }).catch(err => {
            console.error(`   ❌ Error checking DB for lesson ${lesson.id}:`, err.message);
          });
        }
      });
    }
    
    return result;
  },

  /**
   * Find one lesson (override to populate properly)
   */
  async findOne(ctx) {
    // Ensure proper population - handle both missing populate and populate=*
    const populateValue = ctx.query.populate;
    
    if (!populateValue || populateValue === '*' || populateValue === 'true') {
      // Set explicit populate to ensure files are included
      ctx.query.populate = {
        module: {
          populate: ['course']
        },
        teacher_file: true,
        student_file: true,
        homework_file: true,
        ppt_file: true,
      };
    } else if (typeof populateValue === 'object') {
      // If populate is already an object, ensure file fields are included
      ctx.query.populate = {
        ...populateValue,
        module: populateValue.module || {
          populate: ['course']
        },
        teacher_file: populateValue.teacher_file !== false ? true : false,
        student_file: populateValue.student_file !== false ? true : false,
        homework_file: populateValue.homework_file !== false ? true : false,
        ppt_file: populateValue.ppt_file !== false ? true : false,
      };
    }

    return await super.findOne(ctx);
  },
}));