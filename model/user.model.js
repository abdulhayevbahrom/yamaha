const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    tgUserId: {
      type: String,
      required: true,
      unique: true,
    },
    username: {
      type: String,
      default: "",
      index: true,
    },
    profileName: {
      type: String,
      default: "",
      trim: true,
    },
    referralCode: {
      type: String,
      default: undefined,
      unique: true,
      sparse: true,
      trim: true,
    },
    referredByUserId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    referredByCode: {
      type: String,
      default: "",
      trim: true,
    },
    referredAt: {
      type: Date,
      default: null,
    },
    referralActivatedAt: {
      type: Date,
      default: null,
    },
    referralSignupBonusGrantedAt: {
      type: Date,
      default: null,
    },
    referralEarningsTotal: {
      type: Number,
      default: 0,
    },
    referralSignupBonusTotal: {
      type: Number,
      default: 0,
    },
    referralOrderCommissionTotal: {
      type: Number,
      default: 0,
    },
    balance: {
      type: Number,
      default: 0,
    },
    isBlocked: {
      type: Boolean,
      default: false,
      index: true,
    },
    blockedAt: {
      type: Date,
      default: null,
    },
    blockedReason: {
      type: String,
      default: "",
      trim: true,
    },
    blockedByAdminId: {
      type: String,
      default: "",
      trim: true,
    },
    blockedByAdminUsername: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("User", userSchema);
