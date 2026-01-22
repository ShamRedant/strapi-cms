module.exports = ({ env }) => ({
  upload: {
    config: {
      provider: "aws-s3",
      providerOptions: {
        s3Options: {
          region: env("AWS_REGION"),
          credentials: {
            accessKeyId: env("AWS_ACCESS_KEY_ID"),
            secretAccessKey: env("AWS_ACCESS_SECRET"),
          },
          signedUrlExpires: 10 * 60, 
        },
        params: {
          Bucket: env("AWS_BUCKET"),
        },
      },
      actionOptions: {
        upload: { 
          ACL: null
        },
        uploadStream: { 
          ACL: null
        },
      },
      breakpoints: {
        large: 1000,
        medium: 750,
        small: 500,
      },
    },
  },
});