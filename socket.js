const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { parseInitData } = require("./middleware/telegram-auth.middleware");

let ioInstance = null;

const userRoom = (tgUserId) => `user:${String(tgUserId || "").trim()}`;
const adminRoom = () => "admins";

function getAdminPayload(token) {
  if (!token) return null;

  try {
    const secret = process.env.JWT_SECRET_KEY;
    if (!secret) return null;
    const payload = jwt.verify(token, secret);
    return payload?.role === "admin" ? payload : null;
  } catch (_) {
    return null;
  }
}

const connect = (server) => {
  const io = new Server(server, {
    cors: {
      origin: true,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    const rawInitData = String(socket.handshake.auth?.initData || "").trim();
    const parsedInitData = parseInitData(rawInitData);
    const handshakeTgUserId = String(
      socket.handshake.auth?.tgUserId || socket.handshake.query?.tgUserId || "",
    ).trim();
    if (
      parsedInitData?.ok &&
      parsedInitData?.user?.tgUserId &&
      (!handshakeTgUserId || handshakeTgUserId === parsedInitData.user.tgUserId)
    ) {
      socket.join(userRoom(parsedInitData.user.tgUserId));
    }

    const admin = getAdminPayload(socket.handshake.auth?.token);
    if (admin) {
      socket.join(adminRoom());
      socket.data.admin = admin;
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
