const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseBroadcastButtons,
  parseTashkentSchedule,
} = require("../bot/index");
const { sendBroadcastMessage } = require("../services/broadcast-worker.service");

test("broadcast buttons require a valid label and HTTP URL", () => {
  assert.deepEqual(parseBroadcastButtons("Do'kon | https://example.com"), {
    ok: true,
    buttons: [[{ text: "Do'kon", url: "https://example.com" }]],
  });
  assert.equal(parseBroadcastButtons("x | javascript:alert(1)").ok, false);
});

test("broadcast app button becomes a Telegram Web App button", () => {
  assert.deepEqual(
    parseBroadcastButtons("PUBG | app:games/pubg", "https://yamaha.example/app"),
    {
      ok: true,
      buttons: [[{
        text: "PUBG",
        web_app: { url: "https://yamaha.example/app#/games/pubg" },
      }]],
    },
  );
  assert.equal(
    parseBroadcastButtons("X | app:unknown", "https://yamaha.example").ok,
    false,
  );
});

test("broadcast schedule interprets admin time as Asia/Tashkent", () => {
  const date = parseTashkentSchedule("2099-11-02 21:30");
  assert.equal(date.toISOString(), "2099-11-02T16:30:00.000Z");
});

test("video broadcast preserves caption, entities and buttons", async () => {
  let call;
  const bot = {
    sendVideo: async (...args) => {
      call = args;
      return { message_id: 42 };
    },
  };
  const result = await sendBroadcastMessage(bot, {
    type: "video",
    fileId: "video-file",
    text: "Yangilik",
    captionEntities: [{ type: "bold", offset: 0, length: 8 }],
    buttons: [[{ text: "Ochish", url: "https://example.com" }]],
  }, "1001");

  assert.equal(result.message_id, 42);
  assert.equal(call[0], "1001");
  assert.equal(call[1], "video-file");
  assert.equal(call[2].caption, "Yangilik");
  assert.equal(call[2].reply_markup.inline_keyboard[0][0].text, "Ochish");
});
