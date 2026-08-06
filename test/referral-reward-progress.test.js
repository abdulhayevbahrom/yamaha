const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRewardCatalog,
  buildRewardProgressState,
} = require("../services/referral-promo-code.service");

test("primary referral reward repeats for every threshold multiple", () => {
  const catalog = buildRewardCatalog([
    {
      key: "premium_1m_30",
      label: "1 oylik Premium",
      inviteThreshold: 30,
      serviceType: "premium",
      serviceValue: 1,
      active: true,
    },
  ]);

  const progress = buildRewardProgressState(catalog, 65, {
    premium_1m_30: 1,
  });

  assert.equal(progress.availableRewardCount, 2);
  assert.equal(progress.claimedRewardCount, 1);
  assert.equal(progress.remainingRewardCount, 1);
  assert.equal(progress.nextMilestoneInviteCount, 90);
  assert.equal(progress.sortedRewards[0].repeatable, true);
  assert.equal(progress.sortedRewards[0].remainingClaimCount, 1);
});

test("repeatable referral reward does not unlock early", () => {
  const catalog = buildRewardCatalog([
    {
      key: "premium_1m_30",
      label: "1 oylik Premium",
      inviteThreshold: 30,
      active: true,
    },
  ]);

  const progress = buildRewardProgressState(catalog, 59, {
    premium_1m_30: 1,
  });

  assert.equal(progress.availableRewardCount, 1);
  assert.equal(progress.remainingRewardCount, 0);
  assert.equal(progress.nextMilestoneInviteCount, 60);
});
