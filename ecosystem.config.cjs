const path = require("node:path");

const cwd = __dirname;
const productionLogging = path.join(cwd, "config", "production-logging.js");

const productionLogOptions = {
  node_args: ["--require", productionLogging],
  // Routine console.log/info/warn output must not create ever-growing files.
  // console.error and fatal process errors still go to each app's error_file.
  out_file: "/dev/null",
};

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
      ...productionLogOptions,
      error_file: path.join(cwd, "yamaha-api-error.log"),
      env: {
        NODE_ENV: "production",
        ENABLE_TELEGRAM_WORKERS: "false",
        ENABLE_NFT_RECIPIENT_LISTENER: "true",
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
      ...productionLogOptions,
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
      ...productionLogOptions,
      error_file: path.join(cwd, "yamaha-cardxabar-client-error.log"),
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
