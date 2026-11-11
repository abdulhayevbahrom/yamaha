const test = require("node:test");
const assert = require("node:assert/strict");

const Plan = require("../model/plan.model");
const {
  getArchiveAmountLabel,
  getArchiveWebAppReplyMarkup,
} = require("../services/order-archive.service");

test("archive message button opens the bot start flow", () => {
  const originalBotUsername = process.env.BOT_USERNAME;
  process.env.BOT_USERNAME = "@yamaha_shop_bot";

  try {
    assert.deepEqual(getArchiveWebAppReplyMarkup(), {
      inline_keyboard: [[
        {
          text: "🛍 Do'konga kirish",
          url: "https://t.me/yamaha_shop_bot?start=archive",
        },
      ]],
    });
  } finally {
    if (originalBotUsername === undefined) delete process.env.BOT_USERNAME;
    else process.env.BOT_USERNAME = originalBotUsername;
  }
});

test("archive amount shows star quantity instead of generic plan label", async () => {
  const originalFindOne = Plan.findOne;
  Plan.findOne = () => ({
    select: () => ({
      lean: async () => ({ label: "Stars", amount: 750 }),
    }),
  });

  try {
    const amount = await getArchiveAmountLabel({
      product: "star",
      planCode: "stars_750",
      customAmount: 0,
      starsAmount: 0,
    });

    assert.equal(amount, "750");
  } finally {
    Plan.findOne = originalFindOne;
  }
});

test("archive amount falls back to stored stars amount for star orders", async () => {
  const amount = await getArchiveAmountLabel({
    product: "star",
    planCode: "stars",
    customAmount: 0,
    starsAmount: 500,
  });

  assert.equal(amount, 500);
});
