const test = require("node:test");
const assert = require("node:assert/strict");

const Order = require("../model/order.model");
const PaymentAmountReservation = require("../model/payment-amount-reservation.model");
const {
  reservePaymentAmount,
} = require("../services/payment-amount-reservation.service");

const originalOrderExists = Order.exists;
const originalFindOneAndUpdate = PaymentAmountReservation.findOneAndUpdate;
const originalCreate = PaymentAmountReservation.create;

test.afterEach(() => {
  Order.exists = originalOrderExists;
  PaymentAmountReservation.findOneAndUpdate = originalFindOneAndUpdate;
  PaymentAmountReservation.create = originalCreate;
});

test("balance topup reservation rejects an already occupied exact amount", async () => {
  Order.exists = async () => true;
  let created = false;
  PaymentAmountReservation.findOneAndUpdate = async () => null;
  PaymentAmountReservation.create = async () => {
    created = true;
    return null;
  };

  const result = await reservePaymentAmount({
    baseAmount: 10_000,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    allowOffset: false,
  });

  assert.equal(result, null);
  assert.equal(created, false);
});

test("balance topup reservation accepts the exact amount when it is free", async () => {
  Order.exists = async () => false;
  PaymentAmountReservation.findOneAndUpdate = () => ({
    lean: async () => null,
  });
  PaymentAmountReservation.create = async (payload) => ({
    _id: "reservation-id",
    token: payload.token,
    amount: payload.amount,
    expiresAt: payload.expiresAt,
  });

  const result = await reservePaymentAmount({
    baseAmount: 10_000,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    allowOffset: false,
  });

  assert.equal(result.amount, 10_000);
  assert.equal(typeof result.token, "string");
  assert.equal(result.reservationId, "reservation-id");
});
