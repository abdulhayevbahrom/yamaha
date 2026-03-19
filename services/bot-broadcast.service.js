const User = require("../model/user.model");
const { sendTelegramText } = require("./telegram-notify.service");

async function broadcastBotResumed() {
  const users = await User.find({ tgUserId: { $exists: true, $ne: "" } })
    .select({ tgUserId: 1 })
    .lean();

  let sent = 0;
  for (const user of users) {
    const result = await sendTelegramText(
      user.tgUserId,
      "Bot faoliyatini boshladi. Qayta /start bosib davom etishingiz mumkin.",
    );
    if (result.ok) sent += 1;
  }

  return { ok: true, sent };
}

module.exports = {
  broadcastBotResumed,
};
