const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { parseInitData } = require("./middleware/telegram-auth.middleware");

let ioInstance = null;

const userRoom = (tgUserId) => `user:${String(tgUserId || "").trim()}`;
const adminRoom = () => "admins";

function normalizeString(value) {
  return String(value || "").trim();
}

function getAllowedOrigins() {
  return new Set(
    [
      normalizeString(process.env.WEB_APP_URL),
      ...normalizeString(process.env.CORS_ORIGINS)
        .split(",")
        .map((item) => item.trim()),
    ].filter(Boolean),
  );
}

function getAdminPayload(token, parsedInitData) {
  if (!token || !parsedInitData?.ok) return null;

  try {
    const secret = process.env.JWT_SECRET_KEY;
    if (!secret) return null;
    const payload = jwt.verify(token, secret, {
      issuer: "yamaha-api",
      audience: "yamaha-admin",
    });
    if (
      payload?.role !== "admin" ||
      !payload?.tgUserId ||
      String(payload.tgUserId) !== String(parsedInitData.user?.tgUserId || "")
    ) {
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

const connect = (server) => {
  const allowedOrigins = getAllowedOrigins();
  const allowNoOrigin =
    normalizeString(process.env.SOCKET_ALLOW_NO_ORIGIN).toLowerCase() ===
    "true";
  const isOriginAllowed = (origin) =>
    origin ? allowedOrigins.has(origin) : allowNoOrigin;

  const io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (isOriginAllowed(origin)) return callback(null, true);
        return callback(new Error("Socket origin ruxsat etilmagan"));
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
    allowRequest: (req, callback) => {
      callback(null, isOriginAllowed(normalizeString(req.headers.origin)));
    },
  });

  io.use((socket, next) => {
    const rawInitData = String(socket.handshake.auth?.initData || "").trim();
    const parsedInitData = parseInitData(rawInitData);
    if (!parsedInitData?.ok || !parsedInitData?.user?.tgUserId) {
      return next(new Error("Telegram socket sessiyasi yaroqsiz"));
    }

    const handshakeTgUserId = String(
      socket.handshake.auth?.tgUserId || socket.handshake.query?.tgUserId || "",
    ).trim();
    if (
      handshakeTgUserId &&
      handshakeTgUserId !== parsedInitData.user.tgUserId
    ) {
      return next(new Error("Telegram socket foydalanuvchisi mos emas"));
    }

    const admin = getAdminPayload(
      socket.handshake.auth?.token,
      parsedInitData,
    );
    socket.data.telegramAuth = parsedInitData;
    socket.data.admin = admin;
    return next();
  });

  io.on("connection", (socket) => {
    const parsedInitData = socket.data.telegramAuth;
    socket.join(userRoom(parsedInitData.user.tgUserId));

    const admin = socket.data.admin;
    if (admin) {
      socket.join(adminRoom());
    }

    socket.on("ping-miniapp", (payload) => {
      socket.emit("pong-miniapp", {
        ok: true,
        payload: payload || null,
        time: new Date().toISOString(),
      });
    });

    socket.on("disconnect", () => {});
  });

  ioInstance = io;
  return io;
};

const getIO = () => ioInstance;

const emitUserUpdate = (tgUserId, payload = {}) => {
  if (!ioInstance || !tgUserId) return;
  ioInstance.to(userRoom(tgUserId)).emit("app:update", {
    scope: "user",
    tgUserId: String(tgUserId),
    ...payload,
  });
};

const emitAdminUpdate = (payload = {}) => {
  if (!ioInstance) return;
  ioInstance.to(adminRoom()).emit("app:update", {
    scope: "admin",
    ...payload,
  });
};

module.exports = { connect, getIO, emitUserUpdate, emitAdminUpdate };
