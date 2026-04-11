const axios = require("axios");

const BOT_TOKEN = String(process.env.BOT_TOKEN || "").trim();
const CACHE_TTL_MS = 5 * 60 * 1000;
const EMPTY_CACHE_TTL_MS = 2 * 60 * 1000;

const profilePhotoCache = new Map();

function normalizeString(value) {
  return String(value || "").trim();
}

function getCachedPhoto(tgUserId) {
  const cached = profilePhotoCache.get(tgUserId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    profilePhotoCache.delete(tgUserId);
    return null;
  }
  return cached.value;
}

function setCachedPhoto(tgUserId, value, ttlMs) {
  profilePhotoCache.set(tgUserId, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
}

async function getTelegramUserProfilePhoto(tgUserIdRaw) {
  const tgUserId = normalizeString(tgUserIdRaw);
  if (!tgUserId || !BOT_TOKEN) return null;

  const cached = getCachedPhoto(tgUserId);
  if (cached !== null) return cached;

  try {
    const photosResponse = await axios.get(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUserProfilePhotos`,
      {
        params: {
          user_id: tgUserId,
          limit: 1,
        },
        timeout: 8000,
      },
    );

    const photos = photosResponse?.data?.result?.photos;
    const firstGroup = Array.isArray(photos) && photos.length ? photos[0] : null;
    const targetPhoto =
      Array.isArray(firstGroup) && firstGroup.length
        ? firstGroup[firstGroup.length - 1]
        : null;
    const fileId = normalizeString(targetPhoto?.file_id);

    if (!fileId) {
      setCachedPhoto(tgUserId, null, EMPTY_CACHE_TTL_MS);
      return null;
    }

    const fileResponse = await axios.get(
      `https://api.telegram.org/bot${BOT_TOKEN}/getFile`,
      {
        params: { file_id: fileId },
        timeout: 8000,
      },
    );

    const filePath = normalizeString(fileResponse?.data?.result?.file_path);
    if (!filePath) {
      setCachedPhoto(tgUserId, null, EMPTY_CACHE_TTL_MS);
      return null;
    }

    const downloadResponse = await axios.get(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`,
      {
        responseType: "arraybuffer",
        timeout: 10000,
      },
    );

    const buffer = Buffer.from(downloadResponse.data || "");
    if (!buffer.length) {
      setCachedPhoto(tgUserId, null, EMPTY_CACHE_TTL_MS);
      return null;
    }

    const mimeType = normalizeString(downloadResponse?.headers?.["content-type"]);
    const payload = {
      buffer,
      mimeType: mimeType || "image/jpeg",
    };

    setCachedPhoto(tgUserId, payload, CACHE_TTL_MS);
    return payload;
  } catch (_) {
    setCachedPhoto(tgUserId, null, EMPTY_CACHE_TTL_MS);
    return null;
  }
}

module.exports = {
  getTelegramUserProfilePhoto,
};
