const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { getTelegramCredentials } = require("../config/telegram-credentials");

const telegramCredentials = getTelegramCredentials("premium_check");
const apiId = telegramCredentials.apiId;
const apiHash = telegramCredentials.apiHash;
const sessionString = telegramCredentials.sessionString;

let client = null;
let connectPromise = null;

const TELEGRAM_TYPE_NOT_FOUND_RE =
  /TypeNotFoundError|matching Constructor ID|TLObject|constructor id/i;

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

function isTelegramTypeNotFoundError(error) {
  const message = String(error?.message || error?.errorMessage || "").trim();
  const name = String(error?.name || "").trim();
  return TELEGRAM_TYPE_NOT_FOUND_RE.test(message) || name === "TypeNotFoundError";
}

function patchTelegramInvokeWithRetry(instance, scopeLabel) {
  if (!instance || instance.__yamahaInvokePatched) return;

  const rawInvoke = instance.invoke.bind(instance);
  instance.invoke = async (request, dcId) => {
    try {
      return await rawInvoke(request, dcId);
    } catch (error) {
      if (!isTelegramTypeNotFoundError(error)) {
        throw error;
      }

      const requestName = String(request?.className || "").trim() || "unknown";
      console.warn(
        `[${scopeLabel}] TypeNotFoundError: ${requestName} uchun reconnect + retry ishlatildi.`,
      );

      await instance.disconnect().catch(() => {});
      await instance.connect();
      return rawInvoke(request, dcId);
    }
  };

  instance.__yamahaInvokePatched = true;
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

    // Premium-check servisga real-time update kerak emas.
    client._loopStarted = true;
    patchTelegramInvokeWithRetry(client, "telegram-premium-check");
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
