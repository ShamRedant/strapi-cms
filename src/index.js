'use strict';

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register({ strapi }) {
    // Load the upload extension
    const uploadExtension = require('./extensions/upload/strapi-server.js');
    
    // Get the upload plugin
    const uploadPlugin = strapi.plugin('upload');
    
    if (uploadPlugin) {
      console.log('🚀 Loading custom upload extension...');
      
      // Apply the extension to the plugin
      uploadExtension(uploadPlugin);
      
      console.log('✅ Custom upload extension loaded successfully');
    } else {
      console.error('❌ Upload plugin not found');
    }
  },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * Wrap the S3 provider to inject lesson path - provider is set during plugin register
   */
  async bootstrap({ strapi }) {
    // Subscribe to lesson lifecycle - move files to correct S3 folder after lesson is created/updated
    strapi.db.lifecycles.subscribe({
      models: ['api::lesson.lesson'],
      
      async afterCreate(event) {
        const { result } = event;
        const lessonId = result?.id ?? result?.documentId;
        if (lessonId) {
          console.log('Lesson afterCreate triggered for:', lessonId);
          const { reorganizeLessonFiles } = require('./api/lesson/content-types/lesson/lifecycles');
          await reorganizeLessonFiles(lessonId);
        }
      },
      
      async afterUpdate(event) {
        const { result } = event;
        const lessonId = result?.id ?? result?.documentId;
        if (lessonId) {
          console.log('Lesson afterUpdate triggered for:', lessonId);
          const { reorganizeLessonFiles } = require('./api/lesson/content-types/lesson/lifecycles');
          await reorganizeLessonFiles(lessonId);
        }
      },
    });
    
    console.log('✅ Lesson lifecycle subscribed - files will be moved to S3 folders after lesson save');
  },
};