'use strict';

/**
 * Shared upload context - passes path/fileName from upload service to S3 provider
 * Uses AsyncLocalStorage for request isolation (safe for concurrent uploads)
 */
const { AsyncLocalStorage } = require('async_hooks');

const uploadContextStorage = new AsyncLocalStorage();

/**
 * Get the next file context for the current request (path + fileName)
 * Called by the S3 provider when uploading
 */
function getNextFileContext() {
  const store = uploadContextStorage.getStore();
  if (!store || !Array.isArray(store)) return null;
  return store.shift();
}

/**
 * Run the upload flow with file contexts
 * Called by the upload service override before calling original
 */
function runWithFileContexts(contexts, fn) {
  return uploadContextStorage.run(contexts, fn);
}

module.exports = {
  getNextFileContext,
  runWithFileContexts,
};
