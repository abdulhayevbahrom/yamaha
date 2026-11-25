const axios = require("axios");
const response = require("../utils/response");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function detectImageType(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "";
}

async function uploadImage(req, res) {
  const buffer = req.body;
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return response.error(res, "Rasm faylini tanlang");
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({ state: false, message: "Rasm hajmi 5 MB dan oshmasligi kerak", innerData: null });
  }
  if (!detectImageType(buffer)) {
    return response.error(res, "PNG, JPEG, GIF yoki WebP rasm tanlang");
  }

  const apiKey = String(process.env.IMGBB_API_KEY || "").trim();
  if (!apiKey) {
    return response.serverError(res, "Rasm yuklash xizmati sozlanmagan");
  }

  try {
    const form = new URLSearchParams({
      key: apiKey,
      image: buffer.toString("base64"),
    });
    const { data: payload } = await axios.post("https://api.imgbb.com/1/upload", form.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 30_000,
      maxRedirects: 0,
      maxContentLength: 1024 * 1024,
    });
    const imageUrl = String(payload?.data?.url || payload?.data?.display_url || "").trim();
    const parsedUrl = new URL(imageUrl);
    if (
      payload?.success !== true ||
      parsedUrl.protocol !== "https:" ||
      parsedUrl.username || parsedUrl.password || parsedUrl.port ||
      !(parsedUrl.hostname === "i.ibb.co" || parsedUrl.hostname.endsWith(".ibb.co"))
    ) {
      throw new Error("Invalid image response");
    }
    return response.created(res, "Rasm yuklandi", { imageUrl });
  } catch (_) {
    // Provider errors can contain the request and its secret API key.
    return res.status(502).json({
      state: false,
      message: "Rasm yuklab bo'lmadi. Keyinroq qayta urinib ko'ring.",
      innerData: null,
    });
  }
}

module.exports = { uploadImage, MAX_IMAGE_BYTES };
