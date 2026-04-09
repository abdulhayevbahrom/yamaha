const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { getTelegramCredentials } = require("../config/telegram-credentials");

const telegramCredentials = getTelegramCredentials("premium_check");
const apiId = telegramCredentials.apiId;
const apiHash = telegramCredentials.apiHash;
const sessionString = telegramCredentials.sessionString;

let client = null;
let connectPromise = null;

function isTelegramPremiumCheckConfigured() {
  return Boolean(apiId && apiHash && sessionString && sessionString !== "test uchun");
}

function normalizeTelegramIdentifier(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "");
}

function resolveEntityInput(identifier) {
  const cleaned = normalizeTelegramIdentifier(identifier);
  if (!cleaned) return "";
  if (/^\d+$/.test(cleaned)) {
    const numeric = Number(cleaned);
    return Number.isSafeInteger(numeric) ? numeric : cleaned;
  }
  return cleaned;
}

async function getTelegramPremiumCheckClient() {
  if (!isTelegramPremiumCheckConfigured()) {
    throw new Error(
      `Telegram premium check sozlanmagan. ${telegramCredentials.acceptedKeys.apiId.join(" yoki ")}, ${telegramCredentials.acceptedKeys.apiHash.join(" yoki ")} va haqiqiy ${telegramCredentials.acceptedKeys.session.join(" yoki ")} kerak.`,
    );
  }

  if (!client) {
    client = new TelegramClient(
      new StringSession(sessionString),
      apiId,
      apiHash,
      { connectionRetries: 5 },
    );
  }

  if (client.connected) {
    return client;
  }

  if (!connectPromise) {
    connectPromise = client
      .connect()
      .then(async () => {
        const authorized = await client.checkAuthorization();
        if (!authorized) {
          throw new Error(
            `${telegramCredentials.resolvedKeys.session || telegramCredentials.preferredKeys.session} yaroqsiz yoki eskirgan. Yangi session string kerak.`,
          );
        }
        return client;
      })
      .finally(() => {
        connectPromise = null;
      });
  }

  return connectPromise;
}

async function checkTelegramPremium(identifier) {
  const entityInput = resolveEntityInput(identifier);
  if (!entityInput) {
    throw new Error("Username yoki tgUserId kiriting");
  }

  const telegramClient = await getTelegramPremiumCheckClient();
  const entity = await telegramClient.getEntity(entityInput);

  return {
    id: entity?.id ? String(entity.id) : "",
    username: String(entity?.username || "").trim(),
    firstName: String(entity?.firstName || "").trim(),
    isPremium: Boolean(entity?.premium),
  };
}

module.exports = {
  checkTelegramPremium,
  isTelegramPremiumCheckConfigured,
};
