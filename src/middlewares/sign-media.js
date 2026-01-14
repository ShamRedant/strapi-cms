const { getPresignedUrl } = require("../utils/s3");

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

const resolveKey = (file) => {
  if (!file) return null;

  // Prefer provider metadata if present
  if (file.provider_metadata?.key) {
    return file.provider_metadata.key;
  }

  // Use explicit path + filename when available
  if (file.hash && file.ext) {
    const prefix = file.path ? `${file.path.replace(/^\/+/, "")}/` : "";
    return `${prefix}${file.hash}${file.ext}`;
  }

  // Derive from URL as a fallback
  if (file.url) {
    try {
      const { pathname } = new URL(file.url, "http://placeholder");
      return pathname.replace(/^\/+/, "");
    } catch {
      return file.url.replace(/^\/+/, "");
    }
  }

  return null;
};

const signFile = async (file) => {
  if (!file || !file.url) return;

  const key = resolveKey(file);
  if (!key) return;

  // Sign primary file
  file.url = await getPresignedUrl(key);

  // Sign derivatives (e.g., thumbnails)
  if (isObject(file.formats)) {
    const formatValues = Object.values(file.formats);
    await Promise.all(
      formatValues.map(async (fmt) => {
        const formatKey = resolveKey(fmt);
        if (formatKey && fmt.url) {
          fmt.url = await getPresignedUrl(formatKey);
        }
      })
    );
  }
};

const traverseAndSign = async (value) => {
  if (Array.isArray(value)) {
    await Promise.all(value.map(traverseAndSign));
    return;
  }

  if (!isObject(value)) return;

  // Heuristic: media objects usually have url + mime or provider
  const looksLikeMedia =
    typeof value.url === "string" &&
    (typeof value.mime === "string" ||
      value.provider === "aws-s3" ||
      isObject(value.formats));

  if (looksLikeMedia) {
    await signFile(value);
  }

  // Traverse nested objects
  await Promise.all(Object.values(value).map(traverseAndSign));
};

module.exports = (config, { strapi }) => {
  return async (ctx, next) => {
    await next();

    // Only sign JSON responses on reads
    if (ctx.method !== "GET") return;
    if (!ctx.body || typeof ctx.body !== "object") return;

    const targets = [];

    if (ctx.body.data !== undefined) {
      targets.push(ctx.body.data);
    } else {
      targets.push(ctx.body);
    }

    await Promise.all(targets.map(traverseAndSign));
  };
};

