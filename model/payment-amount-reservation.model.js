const mongoose = require("mongoose");

const paymentAmountReservationSchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

paymentAmountReservationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model(
  "PaymentAmountReservation",
  paymentAmountReservationSchema,
);
