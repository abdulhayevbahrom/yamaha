const mongoose = require("mongoose");

const userGiftSchema = new mongoose.Schema(
  {
    tgUserId: {
      type: String,
      required: true,
      index: true,
    },
    tgUsername: {
      type: String,
      default: "",
      trim: true,
    },
    giftId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    stars: {
      type: Number,
      default: 0,
    },
    priceUzs: {
      type: Number,
      default: 0,
    },
    emoji: {
      type: String,
      default: "🎁",
    },
    title: {
      type: String,
      default: "Gift",
      trim: true,
    },
    status: {
      type: String,
      enum: ["owned", "sending", "sent", "send_needs_review"],
      default: "owned",
      index: true,
    },
    sendRequestId: {
      type: String,
      default: "",
      trim: true,
    },
    sendStartedAt: {
      type: Date,
      default: null,
    },
    sendError: {
      type: String,
      default: "",
      trim: true,
    },
    sentToType: {
      type: String,
      enum: ["", "self", "friend"],
      default: "",
    },
    sentToValue: {
      type: String,
      default: "",
      trim: true,
    },
    sentToResolved: {
      type: String,
      default: "",
      trim: true,
    },
    sentAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

userGiftSchema.index({ tgUserId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("UserGift", userGiftSchema);
