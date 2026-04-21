const path = require("node:path");

const cwd = __dirname;

module.exports = {
  apps: [
    {
      name: "yamaha-api",
      cwd,
      script: "index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 3000,
      watch: false,
      time: true,
      out_file: path.join(cwd, "yamaha-api-out.log"),
      error_file: path.join(cwd, "yamaha-api-error.log"),
      env: {
        NODE_ENV: "production",
        ENABLE_TELEGRAM_WORKERS: "false",
      },
    },
    {
      name: "yamaha-bot",
      cwd,
      script: "bot/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 3000,
      watch: false,
      time: true,
      out_file: path.join(cwd, "yamaha-bot-out.log"),
      error_file: path.join(cwd, "yamaha-bot-error.log"),
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "yamaha-cardxabar-client",
      cwd,
      script: "user-client/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      watch: false,
      time: true,
      out_file: path.join(cwd, "yamaha-cardxabar-client-out.log"),
      error_file: path.join(cwd, "yamaha-cardxabar-client-error.log"),
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
