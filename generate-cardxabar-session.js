require("dotenv").config();
const readline = require("node:readline");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const rawApiId = String(process.env.CARDXABAR_TG_API_ID || "").trim();
const apiId = Number(rawApiId);
const apiHash = String(process.env.CARDXABAR_TG_API_HASH || "").trim();

if (!rawApiId || !Number.isFinite(apiId) || !apiHash) {
  console.error(
    "CARDXABAR_TG_API_ID yoki CARDXABAR_TG_API_HASH topilmadi. backend/.env ni tekshiring.",
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
      onError: async (error) => {
        console.error("Auth xato:", error?.message || error);
        return false;
      },
    });

    const session = client.session.save();
    console.log("\nCARDXABAR_TG_USER_SESSION:");
    console.log(session);
    console.log("\nbackend/.env ichiga shu ko'rinishda yozing:");
    console.log(`CARDXABAR_TG_USER_SESSION=${session}`);
  } finally {
    rl.close();
    await client.disconnect().catch(() => {});
  }
}

main().catch((error) => {
  console.error("Session yaratishda xatolik:", error?.message || error);
  process.exit(1);
});

