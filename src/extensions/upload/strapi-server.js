'use strict';

/**
 * Upload Extension - Simplified
 * 
 * Files are uploaded to S3 root normally.
 * The lesson lifecycle (src/api/lesson/content-types/lesson/lifecycles.js) 
 * handles moving files to the correct folder after the lesson is saved.
 */
module.exports = (plugin) => {
  // No modifications needed - using default upload behavior
  // Lesson lifecycle will reorganize files after lesson create/update
  return plugin;
};
