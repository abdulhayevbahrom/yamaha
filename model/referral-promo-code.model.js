const mongoose = require("mongoose");

const { Schema } = mongoose;

const referralPromoCodeSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    ownerTgUserId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    ownerUsername: {
      type: String,
      default: "",
      trim: true,
    },
    ownerProfileName: {
      type: String,
      default: "",
      trim: true,
    },
    rewardKey: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    rewardLabel: {
      type: String,
      required: true,
      trim: true,
    },
    rewardType: {
      type: String,
      default: "",
      trim: true,
    },
    rewardValue: {
      type: Number,
      default: 0,
    },
    inviteThreshold: {
      type: Number,
      default: 0,
    },
    cooldownDays: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["pending", "used", "cancelled"],
      default: "pending",
      index: true,
    },
    requestedAt: {
      type: Date,
      default: null,
    },
    usedAt: {
      type: Date,
      default: null,
    },
    usedByAdminId: {
      type: String,
      default: "",
      trim: true,
    },
    usedByAdminUsername: {
      type: String,
      default: "",
      trim: true,
    },
    usedPurpose: {
      type: String,
      default: "",
      trim: true,
    },
    adminNote: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("ReferralPromoCode", referralPromoCodeSchema);
