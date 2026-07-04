const test = require("node:test");
const assert = require("node:assert/strict");

const {
  checkForceJoinMembership,
} = require("../services/force-join.service");

test("force join helper accepts current channel members", async () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.BOT_TOKEN;
  process.env.BOT_TOKEN = "test-bot-token";
  global.fetch = async () => ({
    json: async () => ({
      ok: true,
      result: { status: "member" },
    }),
  });

  try {
    const result = await checkForceJoinMembership("123456", {
      enabled: true,
      channelId: "@yamaha_channel",
      joinUrl: "https://t.me/yamaha_channel",
    });

    assert.equal(result.isMember, true);
    assert.equal(result.canProceed, true);
    assert.equal(result.status, "member");
  } finally {
    global.fetch = originalFetch;
    process.env.BOT_TOKEN = originalToken;
  }
});

test("force join helper rejects users who left the channel", async () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.BOT_TOKEN;
  process.env.BOT_TOKEN = "test-bot-token";
  global.fetch = async () => ({
    json: async () => ({
      ok: true,
      result: { status: "left" },
    }),
  });

  try {
    const result = await checkForceJoinMembership("123456", {
      enabled: true,
      channelId: "@yamaha_channel",
      joinUrl: "https://t.me/yamaha_channel",
    });

    assert.equal(result.isMember, false);
    assert.equal(result.canProceed, false);
    assert.equal(result.status, "left");
  } finally {
    global.fetch = originalFetch;
    process.env.BOT_TOKEN = originalToken;
  }
});
