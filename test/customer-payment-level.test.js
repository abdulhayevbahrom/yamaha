const test = require("node:test");
const assert = require("node:assert/strict");
const {
  qualifiesForLevel,
  selectCustomerPaymentLevel,
  requiresManualTopupReview,
} = require("../services/customer-payment-level.service");

test("level uses only the selected order count criterion", () => {
  const level = { level: 2, isActive: true, qualificationType: "order_count", qualificationValue: 10 };
  assert.equal(qualifiesForLevel(level, { completedOrderCount: 9, completedOrderAmount: 999999999 }), false);
  assert.equal(qualifiesForLevel(level, { completedOrderCount: 10, completedOrderAmount: 0 }), true);
});

test("topup equal to the level limit requires admin review", () => {
  assert.equal(requiresManualTopupReview(109999, 110000), false);
  assert.equal(requiresManualTopupReview(110000, 110000), true);
  assert.equal(requiresManualTopupReview(110001, 110000), true);
});

test("level uses only the selected order amount criterion", () => {
  const level = { level: 3, isActive: true, qualificationType: "order_amount", qualificationValue: 2000000 };
  assert.equal(qualifiesForLevel(level, { completedOrderCount: 1000, completedOrderAmount: 1999999 }), false);
  assert.equal(qualifiesForLevel(level, { completedOrderCount: 0, completedOrderAmount: 2000000 }), true);
});

test("highest independently qualified active level is selected", () => {
  const levels = [
    { level: 1, isActive: true, qualificationType: "order_count", qualificationValue: 0 },
    { level: 2, isActive: true, qualificationType: "order_count", qualificationValue: 5 },
    { level: 3, isActive: true, qualificationType: "order_amount", qualificationValue: 2000000 },
    { level: 4, isActive: false, qualificationType: "order_count", qualificationValue: 10 },
    { level: 5, isActive: true, qualificationType: "order_amount", qualificationValue: 10000000 },
  ];
  assert.equal(selectCustomerPaymentLevel(levels, { completedOrderCount: 20, completedOrderAmount: 3000000 }).level, 3);
});

test("each level ignores the metric that was not selected", () => {
  const levels = [
    { level: 1, isActive: true, qualificationType: "order_amount", qualificationValue: 0 },
    { level: 2, isActive: true, qualificationType: "order_count", qualificationValue: 5 },
    { level: 3, isActive: true, qualificationType: "order_amount", qualificationValue: 2000000 },
  ];
  assert.equal(selectCustomerPaymentLevel(levels, { completedOrderCount: 4, completedOrderAmount: 1000000 }).level, 1);
  assert.equal(selectCustomerPaymentLevel(levels, { completedOrderCount: 5, completedOrderAmount: 0 }).level, 2);
  assert.equal(selectCustomerPaymentLevel(levels, { completedOrderCount: 0, completedOrderAmount: 2000000 }).level, 3);
});
