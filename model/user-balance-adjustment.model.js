const mongoose = require("mongoose");

const { Schema } = mongoose;

const userBalanceAdjustmentSchema = new Schema(
  {
    tgUserId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    username: {
      type: String,
      default: "",
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      default: 0,
    },
    beforeBalance: {
      type: Number,
      default: 0,
    },
    afterBalance: {
      type: Number,
      default: 0,
    },
    adminTgUserId: {
      type: String,
      default: "",
      trim: true,
    },
    adminUsername: {
      type: String,
      default: "",
      trim: true,
    },
    note: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model(
  "UserBalanceAdjustment",
  userBalanceAdjustmentSchema,
);
