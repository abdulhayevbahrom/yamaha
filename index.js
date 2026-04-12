require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createServer } = require("node:http");

const connectDB = require("./config/dbConfig");
const router = require("./router/router");
const socket = require("./socket");
const response = require("./utils/response");
const { startBot } = require("./bot");
const { startUserClient } = require("./user-client");

//ads

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

function isEnabled(value, fallback = true) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  return !["0", "false", "no", "off"].includes(normalized);
}

function shouldStartTelegramWorkers() {
  if (!isEnabled(process.env.ENABLE_TELEGRAM_WORKERS, true)) {
    return false;
  }

  const appInstance = String(process.env.NODE_APP_INSTANCE || "").trim();
  if (appInstance && appInstance !== "0") {
    return false;
  }

  return true;
}
// 
const PORT = Number(process.env.PORT) || 4090;
const app = express();
const server = createServer(app);

const staticCorsOrigins = [
  "http://localhost:5173",
  "https://yamaha-mini-app.vercel.app",
  "https://6vqq74qx-5173.euw.devtunnels.ms",
  String(process.env.WEB_APP_URL || "").trim(),
  String(process.env.MAIN_URL || "").trim(),
  String(process.env.FRONTEND_URL || "").trim(),
].filter(Boolean);

const envCorsOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const allowedOrigins = new Set([...staticCorsOrigins, ...envCorsOrigins]);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("CORS not allowed"));
    },
    credentials: true,
  }),
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

connectDB().catch((err) => {
  console.error("DB ulanishida xato:", err.message);
});

const io = socket.connect(server);
app.set("socket", io);

app.get("/", (_, res) => {
  return response.success(res, "Backend ishlayapti test1", {
    service: "yamaha-miniapp-backend",
    date: new Date().toISOString(),
  });
});

app.use("/api", router);

app.use((_, res) => {
  return response.notFound(res, "Route topilmadi");
});

server.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
  if (shouldStartTelegramWorkers()) {
    startBot();
    startUserClient();
  } else {
    console.log(
      "Telegram workerlar bu processda ishga tushirilmadi (PM2 instance yoki env cheklovi).",
    );
  }
});
