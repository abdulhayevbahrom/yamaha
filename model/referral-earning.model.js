const mongoose = require("mongoose");

const { Schema } = mongoose;

const referralEarningSchema = new Schema(
  {
    uniqueKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ["signup_bonus", "order_commission"],
      required: true,
    },
    referrerTgUserId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    referrerUsername: {
      type: String,
      default: "",
      trim: true,
    },
    referredTgUserId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    referredUsername: {
      type: String,
      default: "",
      trim: true,
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      default: null,
      index: true,
    },
    sourceProduct: {
      type: String,
      default: "",
      trim: true,
    },
    sourceAmount: {
      type: Number,
      default: 0,
    },
    percent: {
      type: Number,
      default: 0,
    },
    amount: {
      type: Number,
      required: true,
      default: 0,
    },
    note: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("ReferralEarning", referralEarningSchema);
