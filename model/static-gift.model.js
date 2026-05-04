const mongoose = require("mongoose");

const staticGiftSchema = new mongoose.Schema(
  {
    giftId: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    title: {
      type: String,
      default: "Gift",
      trim: true,
    },
    emoji: {
      type: String,
      default: "🎁",
      trim: true,
    },
    stars: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
      index: true,
    },
  },
  { timestamps: true },
);

staticGiftSchema.index({ isActive: 1, sortOrder: 1, createdAt: -1 });

module.exports = mongoose.model("StaticGift", staticGiftSchema);
