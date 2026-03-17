require("dotenv").config();
const readline = require("node:readline");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const apiId = Number(process.env.TG_API_ID || 0);
const apiHash = String(process.env.TG_API_HASH || "").trim();

if (!apiId || !apiHash) {
  console.error("TG_API_ID yoki TG_API_HASH topilmadi. backend/.env ni tekshiring.");
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
    console.log("\nTG_USER_SESSION:");
    console.log(session);
    console.log("\nbackend/.env ichiga shu ko'rinishda yozing:");
    console.log(`TG_USER_SESSION=${session}`);
  } finally {
    rl.close();
    await client.disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("Session yaratishda xatolik:", err.message);
  process.exit(1);
});
