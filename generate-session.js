require("dotenv").config();
const readline = require("node:readline");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { getTelegramCredentials } = require("./config/telegram-credentials");

const rawTarget = String(process.env.TG_SESSION_TARGET || process.argv[2] || "gift")
  .trim()
  .toLowerCase();
const target = rawTarget === "cardxabar" ? "cardxabar" : "gift";
const telegramCredentials = getTelegramCredentials(target);
const apiId = telegramCredentials.apiId;
const apiHash = telegramCredentials.apiHash;

if (!apiId || !apiHash) {
  console.error(
    `${target} session uchun API sozlanmagan. ${telegramCredentials.acceptedKeys.apiId.join(" yoki ")} va ${telegramCredentials.acceptedKeys.apiHash.join(" yoki ")} ni backend/.env da tekshiring.`,
  );
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (question) =>
  new Promise((resolve) => {
    rl.question(question, (answer) => resolve(String(answer || "").trim()));
  });

async function main() {
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    await client.start({
      phoneNumber: async () => ask("Telefon raqam (+998...): "),
      phoneCode: async () => ask("Telegram/SMS kod: "),
      password: async () => ask("2FA parol (bo'lmasa Enter): "),
      onError: async (err) => {
        console.error("Auth xato:", err.message);
        return false;
      },
    });

    const session = client.session.save();
    console.log(`\n${telegramCredentials.preferredKeys.session}:`);
    console.log(session);
    console.log("\nbackend/.env ichiga shu ko'rinishda yozing:");
    console.log(`${telegramCredentials.preferredKeys.session}=${session}`);
  } finally {
    rl.close();
    await client.disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("Session yaratishda xatolik:", err.message);
  process.exit(1);
});
