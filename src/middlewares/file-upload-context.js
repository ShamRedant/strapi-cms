'use strict';

module.exports = (config, { strapi }) => {
  return async (ctx, next) => {

    // Only handle actual file upload requests
    // Skip configuration/settings endpoints
    const url = ctx.request.url;
    if (url.includes('/upload/settings') || 
        url.includes('/upload/configuration') ||
        url.includes('/upload/config')) {
      return next();
    }

    // Check for upload endpoints: /api/upload, /upload, or any URL with files
    const hasFiles = ctx.request.files && 
                     typeof ctx.request.files === 'object' && 
                     Object.keys(ctx.request.files).length > 0;
    
    const isUploadRequest = (url.includes('/api/upload') || url.includes('/upload')) && hasFiles;
    
    if (!isUploadRequest) {
      return next();
    }

    console.log('File upload middleware - URL:', url);

    let lessonId = null;
    let lessonDocumentId = null;

    if (ctx.query?.lessonId) lessonId = ctx.query.lessonId;
    if (!lessonId && ctx.request.body?.refId) lessonId = ctx.request.body.refId;
    if (!lessonId && ctx.params?.id) lessonId = ctx.params.id;
    if (!lessonId && ctx.request.body?.data) {
      try {
        const data = typeof ctx.request.body.data === 'string' ? JSON.parse(ctx.request.body.data) : ctx.request.body.data;
        if (data?.id || data?.lessonId) lessonId = data.id || data.lessonId;
      } catch (err) {}
    }
    if (!lessonId && ctx.request.headers['x-lesson-id']) lessonId = ctx.request.headers['x-lesson-id'];

    // Extract document ID from referer (exclude "create" - new lesson form)
    if (!lessonId && ctx.request.headers.referer) {
      const refererMatch = ctx.request.headers.referer.match(/api::lesson\.lesson\/([a-z0-9]+)/i);
      if (refererMatch && refererMatch[1] !== 'create') lessonDocumentId = refererMatch[1];
    }

    if (!lessonId && lessonDocumentId) {
      try {
        const lessons = await strapi.entityService.findMany('api::lesson.lesson', {
          filters: { documentId: lessonDocumentId },
          limit: 1,
        });
        if (lessons?.length > 0) lessonId = lessons[0].id;
      } catch (err) {}
    }

    console.log('Resolved lesson ID:', lessonId);

    if (!lessonId) {
      console.log('No lesson ID found, skipping file context setup');
      return next();
    }

    const files = ctx.request.files;

    // Check if files exist and is an object
    if (!files || typeof files !== 'object') {
      console.log('No files found in request, skipping file context setup');
      console.log('Request files type:', typeof files);
      console.log('Request files value:', files);
      return next();
    }

    const fileKeys = Object.keys(files);
    console.log('Files found:', fileKeys.length, 'file field(s):', fileKeys);

    if (fileKeys.length === 0) {
      console.log('No file fields found, skipping file context setup');
      return next();
    }

    fileKeys.forEach((key) => {
      const fileOrFiles = files[key];

      const fileList = Array.isArray(fileOrFiles)
        ? fileOrFiles
        : [fileOrFiles];

      fileList.forEach((file) => {
        if (!file) return;

        file.related = [
          {
            id: lessonId,
            __type: 'api::lesson.lesson',
            __pivot: { field: key },
          },
        ];

        file.field = key;
      });
    });

    await next();
  };
};
