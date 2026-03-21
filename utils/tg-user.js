function parseEncodedTelegramUser(encodedUser) {
  const raw = String(encodedUser || "").trim();
  if (!raw) return null;

  try {
    const decoded = decodeURIComponent(raw);
    const user = JSON.parse(decoded);
    return {
      tgUserId: String(user?.id || "").trim(),
      username: String(user?.username || "").trim(),
    };
  } catch (_) {
    return null;
  }
}

function parseTelegramUserFromInitData(initData) {
  const raw = String(initData || "").trim();
  if (!raw) return null;

  try {
    const params = new URLSearchParams(raw);
    const userRaw = params.get("user");
    if (!userRaw) return null;

    const user = JSON.parse(userRaw);
    return {
      tgUserId: String(user?.id || "").trim(),
      username: String(user?.username || "").trim(),
    };
  } catch (_) {
    return null;
  }
}

function getTelegramUserFromRequest(req) {
  let tgUserId = String(req.headers["x-tg-user-id"] || "").trim();
  let username = String(req.headers["x-tg-username"] || "").trim();

  const encodedUser = parseEncodedTelegramUser(req.headers["x-tg-user"]);
  if (encodedUser) {
    tgUserId = tgUserId || encodedUser.tgUserId;
    username = username || encodedUser.username;
  }

  const initDataUser = parseTelegramUserFromInitData(
    req.headers["x-tg-init-data"],
  );
  if (initDataUser) {
    tgUserId = tgUserId || initDataUser.tgUserId;
    username = username || initDataUser.username;
  }

  return { tgUserId, username };
}

module.exports = {
  getTelegramUserFromRequest,
};
