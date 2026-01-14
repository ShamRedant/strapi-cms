const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// Single shared client for signing URLs
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_ACCESS_SECRET,
  },
});

/**
 * Generate a pre-signed GET URL for a given object key.
 * @param {string} key - Object key in the bucket.
 * @param {number} expiresIn - Expiration in seconds (default 1 hour).
 * @returns {Promise<string>}
 */
async function getPresignedUrl(key, expiresIn = 3600) {
  if (!key) {
    throw new Error("Missing S3 object key for signing");
  }

  const command = new GetObjectCommand({
    Bucket: process.env.AWS_BUCKET,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}

module.exports = {
  getPresignedUrl,
};

