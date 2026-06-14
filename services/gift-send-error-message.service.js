function normalizeErrorMessage(error) {
  return String(error?.errorMessage || error?.message || "").trim();
}

function getGiftSendErrorMessage(error) {
  const raw = normalizeErrorMessage(error);
  const normalized = raw.toUpperCase();

  if (!normalized) return "Gift yuborishda xatolik yuz berdi";

  if (
    normalized.includes("COULD NOT FIND THE INPUT ENTITY") ||
    normalized.includes("PEERUSER")
  ) {
    return "Telegram foydalanuvchini aniqlay olmadi. Qabul qiluvchining @username manzilini kiriting yoki u gift yuboruvchi xizmat akkauntiga avval yozsin.";
  }
  if (normalized.includes("BALANCE_TOO_LOW")) {
    return "Giftni yechib olish uchun xizmat hisobida stars yetarli emas. Administratorga murojaat qiling";
  }
  if (normalized.includes("USERNAME_INVALID")) {
    return "Username noto'g'ri";
  }
  if (
    normalized.includes("PEER_ID_INVALID") ||
    normalized.includes("USER_ID_INVALID")
  ) {
    return "Foydalanuvchi topilmadi";
  }
  if (normalized.includes("FLOOD_WAIT")) {
    return "Telegram cheklovi sabab birozdan keyin qayta urinib ko'ring";
  }
  if (normalized.includes("TG_USER_SESSION")) {
    return "Telegram session eskirgan. Administratorga murojaat qiling";
  }
  if (normalized.includes("PAYMENT_REQUIRED")) {
    return "Telegram transfer uchun stars to'lovi talab qilindi. Iltimos qayta urinib ko'ring yoki administratorga murojaat qiling";
  }
  if (normalized.includes("STARS") && normalized.includes("LOW")) {
    return "Telegram hisobida stars yetarli emas";
  }

  return "Giftni yuborib bo'lmadi. Iltimos, ma'lumotlarni tekshirib qayta urinib ko'ring.";
}

module.exports = {
  getGiftSendErrorMessage,
};
