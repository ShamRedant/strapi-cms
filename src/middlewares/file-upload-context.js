'use strict';

module.exports = (config, { strapi }) => {
  return async (ctx, next) => {

    // Only handle upload requests
    if (!ctx.request.files || !ctx.request.url.startsWith('/upload')) {
      return next();
    }

    console.log('File upload middleware - URL:', ctx.request.url);

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

    if (!lessonId) return next();

    const files = ctx.request.files;

    Object.keys(files).forEach((key) => {
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
