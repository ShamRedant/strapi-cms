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
    // Ensure proper population
    if (!ctx.query.populate) {
      ctx.query.populate = {
        module: {
          populate: ['course']
        },
        teacher_file: true,
        student_file: true,
        homework_file: true,
        ppt_file: true,
      };
    }

    return await super.find(ctx);
  },

  /**
   * Find one lesson (override to populate properly)
   */
  async findOne(ctx) {
    // Ensure proper population
    if (!ctx.query.populate) {
      ctx.query.populate = {
        module: {
          populate: ['course']
        },
        teacher_file: true,
        student_file: true,
        homework_file: true,
        ppt_file: true,
      };
    }

    return await super.findOne(ctx);
  },
}));