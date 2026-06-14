const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getGiftSendErrorMessage,
} = require("../services/gift-send-error-message.service");

test("Telethon input entity error is converted to a customer-friendly message", () => {
  const raw =
    'Could not find the input entity for {"userId":"7190668598","className":"PeerUser"}';
  const message = getGiftSendErrorMessage(new Error(raw));

  assert.match(message, /@username/);
  assert.doesNotMatch(message, /input entity|PeerUser|7190668598/i);
});

test("unknown technical gift errors are not exposed to customers", () => {
  const message = getGiftSendErrorMessage(
    new Error("SECRET_INTERNAL_TELEGRAM_FAILURE"),
  );

  assert.equal(
    message,
    "Giftni yuborib bo'lmadi. Iltimos, ma'lumotlarni tekshirib qayta urinib ko'ring.",
  );
  assert.doesNotMatch(message, /SECRET_INTERNAL_TELEGRAM_FAILURE/);
});
