const mongoose = require("mongoose");

const { Schema } = mongoose;

const contestPrizeSchema = new Schema(
  {
    place: {
      type: Number,
      required: true,
      min: 1,
    },
    title: {
      type: String,
      default: "",
      trim: true,
    },
    giftId: {
      type: String,
      default: "",
      trim: true,
    },
    giftName: {
      type: String,
      default: "",
      trim: true,
    },
    giftEmoji: {
      type: String,
      default: "🎁",
      trim: true,
    },
    giftImageUrl: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { _id: false },
);

const contestWinnerSchema = new Schema(
  {
    place: {
      type: Number,
      required: true,
      min: 1,
    },
    tgUserId: {
      type: String,
      default: "",
      trim: true,
    },
    username: {
      type: String,
      default: "",
      trim: true,
    },
    profileName: {
      type: String,
      default: "",
      trim: true,
    },
    totalSpent: {
      type: Number,
      default: 0,
    },
    orderCount: {
      type: Number,
      default: 0,
    },
    prizeTitle: {
      type: String,
      default: "",
      trim: true,
    },
    giftId: {
      type: String,
      default: "",
      trim: true,
    },
    giftName: {
      type: String,
      default: "",
      trim: true,
    },
    giftEmoji: {
      type: String,
      default: "🎁",
      trim: true,
    },
    giftImageUrl: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { _id: false },
);

const contestSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    startsAt: {
      type: Date,
      required: true,
      index: true,
    },
    endsAt: {
      type: Date,
      required: true,
      index: true,
    },
    winnerCount: {
      type: Number,
      default: 3,
      min: 1,
    },
    prizes: {
      type: [contestPrizeSchema],
      default: [],
    },
    bannerEmoji: {
      type: String,
      default: "🏆",
      trim: true,
    },
    status: {
      type: String,
      enum: ["scheduled", "active", "completed", "cancelled"],
      default: "scheduled",
      index: true,
    },
    totalSales: {
      type: Number,
      default: 0,
    },
    participantCount: {
      type: Number,
      default: 0,
    },
    winnerSnapshot: {
      type: [contestWinnerSchema],
      default: [],
    },
    completedAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: String,
      default: "",
      trim: true,
    },
    updatedBy: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true },
);

contestSchema.index({ status: 1, startsAt: -1, endsAt: -1 });
contestSchema.index({ endsAt: 1, status: 1 });

module.exports = mongoose.model("Contest", contestSchema);
