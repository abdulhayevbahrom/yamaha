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

const PORT = Number(process.env.PORT) || 4090;
const app = express();
const server = createServer(app);

let urls = ["http://localhost:5173", "https://yamaha-mini-app.vercel.app"];

app.use(
  cors({
    origin: urls,
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
  startBot();
  startUserClient();
});
