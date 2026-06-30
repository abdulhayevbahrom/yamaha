require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createServer } = require("node:http");
const mongoose = require("mongoose");

const connectDB = require("./config/dbConfig");
const router = require("./router/router");
const socket = require("./socket");
const response = require("./utils/response");
const { createWebAppOriginGuard } = require("./middleware/webapp-origin.middleware");
const { createWebAppSessionGuard } = require("./middleware/webapp-session.middleware");
const { createRequestReplayGuard } = require("./middleware/request-replay.middleware");
const { createTurnstileGuard } = require("./middleware/turnstile.middleware");

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

const trustProxyRaw = String(process.env.TRUST_PROXY || "").trim();
if (trustProxyRaw) {
  const parsedTrustProxy = Number(trustProxyRaw);
  if (!Number.isNaN(parsedTrustProxy)) {
    app.set("trust proxy", parsedTrustProxy);
  } else if (["true", "false"].includes(trustProxyRaw.toLowerCase())) {
    app.set("trust proxy", trustProxyRaw.toLowerCase() === "true");
  } else {
    app.set("trust proxy", trustProxyRaw);
  }
} else {
  app.set("trust proxy", false);
}

const staticCorsOrigins = [String(process.env.WEB_APP_URL || "").trim()].filter(
  Boolean,
);

const envCorsOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const allowedOrigins = new Set([...staticCorsOrigins, ...envCorsOrigins]);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

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

const io = socket.connect(server);
app.set("socket", io);

app.get("/", (_, res) => {
  return response.success(res, "Backend ishlayapti", {
    service: "yamaha-miniapp-backend",
    date: new Date().toISOString(),
  });
});

app.use(
  "/api",
  createWebAppOriginGuard({
    allowedOrigins: [...allowedOrigins],
    allowNoOriginGetPrefixes: [
      "/health",
      "/gifts/image/",
      "/gifts/nft-image/",
      "/gifts/nft-pattern/",
      "/hero-slides",
    ],
  }),
  createWebAppSessionGuard({
    ignorePrefixes: ["/health"],
    allowNoInitDataGetPrefixes: [
      "/gifts/image/",
      "/gifts/nft-image/",
      "/gifts/nft-pattern/",
      "/hero-slides",
    ],
  }),
  createRequestReplayGuard({
    windowMs: Number(process.env.REQUEST_REPLAY_WINDOW_MS || 120_000),
    ignorePrefixes: ["/health"],
  }),
  createTurnstileGuard({
    protectedPrefixes: [
      "/orders",
      "/balance/topup",
      "/gifts/",
      "/admin/hero-slides",
      "/admin/login",
    ],
  }),
  router,
);

app.use((_, res) => {
  return response.notFound(res, "Route topilmadi");
});

async function startServer() {
  await connectDB();

  server.listen(PORT, () => {
    console.log(`Server: http://localhost:${PORT}`);
    if (shouldStartTelegramWorkers()) {
      const { startBot } = require("./bot");
      const { startUserClient } = require("./user-client");
      Promise.resolve(startBot({ strict: true })).catch((error) => {
        console.error("Bot start error:", error?.message || error);
      });
      Promise.resolve(startUserClient({ strict: true })).catch((error) => {
        console.error("User-client start error:", error?.message || error);
      });
    } else {
      console.log(
        "Telegram workerlar bu processda ishga tushirilmadi (PM2 instance yoki env cheklovi).",
      );
    }
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: backend to'xtatilmoqda...`);

  const forceExitTimer = setTimeout(() => {
    console.error("Backend belgilangan vaqtda to'xtamadi");
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  if (server.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
  await mongoose.disconnect().catch(() => {});
  clearTimeout(forceExitTimer);
  process.exit(0);
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

startServer().catch((error) => {
  console.error("Backend ishga tushmadi:", error?.message || error);
  process.exit(1);
});
