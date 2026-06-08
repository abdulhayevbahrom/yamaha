const test = require("node:test");
const assert = require("node:assert/strict");

const {
  shouldProcessCardxabarMessage,
} = require("../utils/cardxabar-message-filter");

test("accepts the configured CardXabar chat ID", () => {
  assert.equal(
    shouldProcessCardxabarMessage({
      configuredChatId: "915326936",
      configuredUsername: "CardXabarBot",
      messageChatId: "915326936",
      senderUsername: "",
    }),
    true,
  );
});

test("falls back to the configured username when chat ID is stale", () => {
  assert.equal(
    shouldProcessCardxabarMessage({
      configuredChatId: "8590248255",
      configuredUsername: "CardXabarBot",
      messageChatId: "915326936",
      senderUsername: "cardxabarbot",
    }),
    true,
  );
});

test("rejects messages that match neither configured identity", () => {
  assert.equal(
    shouldProcessCardxabarMessage({
      configuredChatId: "8590248255",
      configuredUsername: "CardXabarBot",
      messageChatId: "123",
      senderUsername: "OtherBot",
    }),
    false,
  );
});
