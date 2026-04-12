const User = require("../model/user.model");
const { sendTelegramText } = require("./telegram-notify.service");

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
  const result = await broadcastToAllUsers(
    "Bot faoliyatini boshladi. Qayta /start bosib davom etishingiz mumkin.",
  );
  return { ...result, type: "resumed" };
}

async function broadcastBotPaused() {
  const result = await broadcastToAllUsers(
    "Bot vaqtincha to'xtatildi. Xizmatlar qisqa muddatga ishlamaydi.",
  );
  return { ...result, type: "paused" };
}

module.exports = {
  broadcastBotResumed,
  broadcastBotPaused,
};
