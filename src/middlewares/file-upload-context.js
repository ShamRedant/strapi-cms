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

    // Valid lesson file fields
    const validLessonFields = ['student_file', 'teacher_file', 'homework_file', 'ppt_file'];
    
    // Try to determine which field to use from query params or headers
    let targetField = ctx.query?.field || ctx.request.headers['x-file-field'];
    
    // If no specific field specified and we have generic "files", use student_file as default
    if (!targetField && fileKeys.includes('files')) {
      targetField = 'student_file';
      console.log('⚠️ Generic "files" field detected, defaulting to student_file');
    }
    
    // Validate the target field
    if (targetField && !validLessonFields.includes(targetField)) {
      console.log(`⚠️ Invalid field "${targetField}", defaulting to student_file`);
      targetField = 'student_file';
    }
    
    // Store mapping for after upload
    const fileFieldMapping = {};
    
    fileKeys.forEach((key) => {
      const fileOrFiles = files[key];

      const fileList = Array.isArray(fileOrFiles)
        ? fileOrFiles
        : [fileOrFiles];

      fileList.forEach((file, index) => {
        if (!file) return;

        // Determine the actual lesson field to use
        let lessonField = key;
        
        // If key is a valid lesson field, use it
        if (validLessonFields.includes(key)) {
          lessonField = key;
        } 
        // If key is "files" and we have a target field, use that
        else if (key === 'files' && targetField) {
          lessonField = targetField;
        }
        // Otherwise, use targetField if available, or default to student_file
        else {
          lessonField = targetField || 'student_file';
        }

        // Set up file relation with field information
        // This will be used by the upload service and file lifecycle hooks
        file.related = [
          {
            id: lessonId,
            __type: 'api::lesson.lesson',
            __pivot: { 
              field: lessonField,
              related_type: 'api::lesson.lesson',
              related_id: lessonId
            },
          },
        ];

        file.field = lessonField; // Use the mapped field name
        file.lessonId = lessonId; // Store for easy access
        
        // Store mapping: if multiple files, we'll link the first one
        if (index === 0) {
          fileFieldMapping[lessonField] = true;
          console.log(`📋 Mapped upload field "${key}" to lesson field "${lessonField}"`);
        }
      });
    });

    // Store in context for after upload
    ctx.state.lessonFileLinking = {
      lessonId: lessonId,
      fileFields: Object.keys(fileFieldMapping),
    };

    await next();

    // After upload completes, link files to lesson
    if (ctx.state.lessonFileLinking && ctx.response && ctx.response.status === 201) {
      try {
        const { lessonId: linkLessonId, fileFields } = ctx.state.lessonFileLinking;
        const responseBody = ctx.response.body;
        
        // Handle both single file and array responses
        const uploadedFiles = Array.isArray(responseBody) ? responseBody : (responseBody ? [responseBody] : []);
        
        if (uploadedFiles.length > 0) {
          console.log(`\n🔗 Attempting to link ${uploadedFiles.length} file(s) to lesson ${linkLessonId}`);
          
          // Map files to fields (assuming order matches)
          const fileUpdates = {};
          fileFields.forEach((field, index) => {
            if (uploadedFiles[index] && uploadedFiles[index].id) {
              fileUpdates[field] = uploadedFiles[index].id;
              console.log(`   Mapping ${field} -> file ID ${uploadedFiles[index].id}`);
            }
          });

          // Update lesson with file references using entityService
          if (Object.keys(fileUpdates).length > 0) {
            console.log(`   Updating lesson ${linkLessonId} with:`, fileUpdates);
            
            try {
              // Use entityService.update - this is the correct way to update media relations
              await strapi.entityService.update('api::lesson.lesson', linkLessonId, {
                data: fileUpdates,
              });
              
              // Verify the update worked by fetching the lesson
              const updatedLesson = await strapi.entityService.findOne('api::lesson.lesson', linkLessonId, {
                fields: ['id'],
                populate: {
                  student_file: { fields: ['id'] },
                  teacher_file: { fields: ['id'] },
                  homework_file: { fields: ['id'] },
                  ppt_file: { fields: ['id'] },
                },
              });
              
              console.log(`✅ Successfully linked files to lesson ${linkLessonId}`);
              console.log(`   Verification - Database state:`);
              console.log(`      student_file: ${updatedLesson?.student_file?.id || 'null'}`);
              console.log(`      teacher_file: ${updatedLesson?.teacher_file?.id || 'null'}`);
              console.log(`      homework_file: ${updatedLesson?.homework_file?.id || 'null'}`);
              console.log(`      ppt_file: ${updatedLesson?.ppt_file?.id || 'null'}\n`);
            } catch (updateError) {
              console.error(`❌ Error updating lesson:`, updateError.message);
              console.error(`   Error details:`, updateError);
              // Don't throw - upload was successful, just linking failed
            }
          } else {
            console.log(`⚠️ No file IDs found in upload response\n`);
          }
        }
      } catch (linkError) {
        console.error('❌ Error linking files to lesson after upload:', linkError);
        console.error('Error details:', linkError.message);
        // Don't throw - upload was successful
      }
    }
  };
};
