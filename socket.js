const { Server } = require("socket.io");

let ioInstance = null;

const connect = (server) => {
  const io = new Server(server, {
    cors: {
      origin: ["http://localhost:5173"],
      methods: ["GET", "POST"],
      credentials: true
    }
  });

  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on("ping-miniapp", (payload) => {
      socket.emit("pong-miniapp", {
        ok: true,
        payload: payload || null,
        time: new Date().toISOString()
      });
    });

    socket.on("disconnect", () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });

  ioInstance = io;
  return io;
};

const getIO = () => ioInstance;

module.exports = { connect, getIO };
