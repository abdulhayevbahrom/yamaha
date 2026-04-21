const User = require("../model/user.model");
const { sendTelegramText } = require("./telegram-notify.service");
const { getBotBroadcastConfig } = require("./settings.service");

async function broadcastToAllUsers(text) {
  const message = String(text || "").trim();
  if (!message) return { ok: false, sent: 0, reason: "empty_message" };

  const users = await User.find({ tgUserId: { $exists: true, $ne: "" } })
    .select({ tgUserId: 1 })
    .lean();

  let sent = 0;
  for (const user of users) {
    const result = await sendTelegramText(user.tgUserId, message);
    if (result.ok) sent += 1;
  }

  return { ok: true, sent };
}

async function broadcastBotResumed() {
  const config = await getBotBroadcastConfig();
  if (!config.sendOnResume) {
    return { ok: true, sent: 0, skipped: true, reason: "disabled_by_admin", type: "resumed" };
  }

  const result = await broadcastToAllUsers(config.resumeText);
  return { ...result, type: "resumed" };
}

async function broadcastBotPaused() {
  const config = await getBotBroadcastConfig();
  if (!config.sendOnPause) {
    return { ok: true, sent: 0, skipped: true, reason: "disabled_by_admin", type: "paused" };
  }

  const result = await broadcastToAllUsers(config.pauseText);
  return { ...result, type: "paused" };
}

module.exports = {
  broadcastBotResumed,
  broadcastBotPaused,
};
