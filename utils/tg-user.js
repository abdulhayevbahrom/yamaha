function normalizeString(value) {
  return String(value || "").trim();
}

function sanitizeProfileName(value) {
  let name = normalizeString(value);
  if (!name) return "";

  try {
    name = name.normalize("NFKC");
  } catch (_) {
    // keep original if normalize fails
  }

  name = name
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (name.length > 64) {
    name = name.slice(0, 64).trim();
  }

  return name;
}

function buildProfileName(user) {
  const directName = normalizeString(
    user?.profile_name || user?.full_name || user?.name,
  );
  if (directName) return sanitizeProfileName(directName);

  const firstName = normalizeString(user?.first_name);
  const lastName = normalizeString(user?.last_name);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  return sanitizeProfileName(fullName);
}

function parseEncodedTelegramUser(encodedUser) {
  const raw = normalizeString(encodedUser);
  if (!raw) return null;

  try {
    const decoded = decodeURIComponent(raw);
    const user = JSON.parse(decoded);
    return {
      tgUserId: normalizeString(user?.id),
      username: normalizeString(user?.username),
      firstName: normalizeString(user?.first_name),
      lastName: normalizeString(user?.last_name),
      profileName: buildProfileName(user),
    };
  } catch (_) {
    return null;
  }
}

function parseTelegramUserFromInitData(initData) {
  const raw = normalizeString(initData);
  if (!raw) return null;

  try {
    const params = new URLSearchParams(raw);
    const userRaw = params.get("user");
    if (!userRaw) return null;

    const user = JSON.parse(userRaw);
    return {
      tgUserId: normalizeString(user?.id),
      username: normalizeString(user?.username),
      firstName: normalizeString(user?.first_name),
      lastName: normalizeString(user?.last_name),
      profileName: buildProfileName(user),
    };
  } catch (_) {
    return null;
  }
}

function getTelegramUserFromRequest(req) {
  let tgUserId = normalizeString(req.headers["x-tg-user-id"]);
  let username = normalizeString(req.headers["x-tg-username"]);
  let firstName = normalizeString(req.headers["x-tg-first-name"]);
  let lastName = normalizeString(req.headers["x-tg-last-name"]);
  let profileName = sanitizeProfileName(req.headers["x-tg-profile-name"]);

  const encodedUser = parseEncodedTelegramUser(req.headers["x-tg-user"]);
  if (encodedUser) {
    tgUserId = tgUserId || encodedUser.tgUserId;
    username = username || encodedUser.username;
    firstName = firstName || encodedUser.firstName;
    lastName = lastName || encodedUser.lastName;
    profileName = profileName || encodedUser.profileName;
  }

  const initDataUser = parseTelegramUserFromInitData(
    req.headers["x-tg-init-data"],
  );
  if (initDataUser) {
    tgUserId = tgUserId || initDataUser.tgUserId;
    username = username || initDataUser.username;
    firstName = firstName || initDataUser.firstName;
    lastName = lastName || initDataUser.lastName;
    profileName = profileName || initDataUser.profileName;
  }

  if (!profileName) {
    profileName = sanitizeProfileName([firstName, lastName].filter(Boolean).join(" "));
  }

  return { tgUserId, username, firstName, lastName, profileName };
}

module.exports = {
  getTelegramUserFromRequest,
};
