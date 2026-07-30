const test = require("node:test");
const assert = require("node:assert/strict");

const {
  checkForceJoinMembership,
  clearForceJoinMembershipCache,
} = require("../services/force-join.service");

test("force join helper accepts current channel members", async () => {
  clearForceJoinMembershipCache();
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
  clearForceJoinMembershipCache();
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

test("force join helper retries transient Telegram errors", async () => {
  clearForceJoinMembershipCache();
  const originalFetch = global.fetch;
  const originalToken = process.env.BOT_TOKEN;
  const originalDelay = process.env.FORCE_JOIN_TELEGRAM_RETRY_DELAY_MS;
  process.env.BOT_TOKEN = "test-bot-token";
  process.env.FORCE_JOIN_TELEGRAM_RETRY_DELAY_MS = "0";
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        status: 429,
        json: async () => ({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
        }),
      };
    }
    return {
      status: 200,
      json: async () => ({
        ok: true,
        result: { status: "member" },
      }),
    };
  };

  try {
    const result = await checkForceJoinMembership("retry-user", {
      enabled: true,
      channelId: "@yamaha_channel",
      joinUrl: "https://t.me/yamaha_channel",
    });

    assert.equal(calls, 2);
    assert.equal(result.canProceed, true);
  } finally {
    global.fetch = originalFetch;
    process.env.BOT_TOKEN = originalToken;
    process.env.FORCE_JOIN_TELEGRAM_RETRY_DELAY_MS = originalDelay;
    clearForceJoinMembershipCache();
  }
});

test("force join helper caches successful membership checks", async () => {
  clearForceJoinMembershipCache();
  const originalFetch = global.fetch;
  const originalToken = process.env.BOT_TOKEN;
  process.env.BOT_TOKEN = "test-bot-token";
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      status: 200,
      json: async () => ({
        ok: true,
        result: { status: "member" },
      }),
    };
  };

  try {
    const config = {
      enabled: true,
      channelId: "@yamaha_channel",
      joinUrl: "https://t.me/yamaha_channel",
    };
    const first = await checkForceJoinMembership("cached-user", config);
    const second = await checkForceJoinMembership("cached-user", config);

    assert.equal(first.canProceed, true);
    assert.equal(second.canProceed, true);
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
    process.env.BOT_TOKEN = originalToken;
    clearForceJoinMembershipCache();
  }
});
