module.exports = [
  "strapi::errors",
  {
    name: "strapi::security",
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "connect-src": ["'self'", "https:"],
          "img-src": [
            "'self'",
            "data:",
            "blob:",
            "https://steps-robotics-dev.s3.ap-south-1.amazonaws.com",
          ],

          "media-src": [
            "'self'",
            "data:",
            "blob:",
            "https://steps-robotics-dev.s3.ap-south-1.amazonaws.com",
          ],

          upgradeInsecureRequests: null,
        },
      },
    },
  },
  "strapi::cors",
  "strapi::poweredBy",
  "strapi::logger",
  "strapi::query",
  "strapi::body",
  "strapi::session",
  "strapi::favicon",
  "global::sign-media",
  "strapi::public",
];
