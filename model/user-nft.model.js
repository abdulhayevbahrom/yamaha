const mongoose = require("mongoose");

const nftBackdropColorsSchema = new mongoose.Schema(
  {
    center: { type: String, default: "#346d2b", trim: true },
    edge: { type: String, default: "#2d5f24", trim: true },
    pattern: { type: String, default: "#8ec95d", trim: true },
    text: { type: String, default: "#eaffdc", trim: true },
  },
  { _id: false },
);

const userNftSchema = new mongoose.Schema(
  {
    nftId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    giftId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    slug: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    title: {
      type: String,
      default: "NFT Gift",
      trim: true,
    },
    nftNumber: {
      type: Number,
      default: 0,
    },
    emoji: {
      type: String,
      default: "🎁",
      trim: true,
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
      index: true,
    },

    sourceFromTgUserId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    sourceFromUsername: {
      type: String,
      default: "",
      trim: true,
    },
    sourceFromName: {
      type: String,
      default: "",
      trim: true,
    },
    sourceMsgId: {
      type: Number,
      default: 0,
      index: true,
    },
    sourceSavedId: {
      type: String,
      default: "",
      trim: true,
    },

    ownerName: {
      type: String,
      default: "",
      trim: true,
    },
    model: {
      type: String,
      default: "",
      trim: true,
    },
    modelRarity: {
      type: String,
      default: "",
      trim: true,
    },
    symbol: {
      type: String,
      default: "",
      trim: true,
    },
    symbolRarity: {
      type: String,
      default: "",
      trim: true,
    },
    backdrop: {
      type: String,
      default: "",
      trim: true,
    },
    backdropRarity: {
      type: String,
      default: "",
      trim: true,
    },
    backdropColors: {
      type: nftBackdropColorsSchema,
      default: () => ({}),
    },
    patternAssetStatus: {
      type: String,
      enum: ["unknown", "available", "missing"],
      default: "unknown",
      index: true,
    },
    patternAssetSourceMethod: {
      type: String,
      default: "",
      trim: true,
    },
    patternAssetSourceLabel: {
      type: String,
      default: "",
      trim: true,
    },
    patternAssetPath: {
      type: String,
      default: "",
      trim: true,
    },
    patternAssetMimeType: {
      type: String,
      default: "",
      trim: true,
    },
    patternAssetMissingReason: {
      type: String,
      default: "",
      trim: true,
    },
    quantityIssued: {
      type: Number,
      default: 0,
    },
    quantityTotal: {
      type: Number,
      default: 0,
    },
    valueStars: {
      type: Number,
      default: 0,
    },
    acquiredAt: {
      type: Date,
      default: null,
    },

    isTelegramPresent: {
      type: Boolean,
      default: true,
      index: true,
    },
    telegramSyncedAt: {
      type: Date,
      default: null,
    },
    withdrawnAt: {
      type: Date,
      default: null,
    },
    withdrawnTo: {
      type: String,
      default: "",
      trim: true,
    },

    marketStatus: {
      type: String,
      enum: ["owned", "listed"],
      default: "owned",
      index: true,
    },
    listingPriceUzs: {
      type: Number,
      default: 0,
    },
    listedAt: {
      type: Date,
      default: null,
      index: true,
    },
    listedByTgUserId: {
      type: String,
      default: "",
      trim: true,
    },

    lastSoldAt: {
      type: Date,
      default: null,
    },
    lastSoldPriceUzs: {
      type: Number,
      default: 0,
    },
    lastSaleFeePercent: {
      type: Number,
      default: 0,
    },
    lastSaleFeeAmountUzs: {
      type: Number,
      default: 0,
    },
    lastSellerNetUzs: {
      type: Number,
      default: 0,
    },
    lastSellerTgUserId: {
      type: String,
      default: "",
      trim: true,
    },
    lastBuyerTgUserId: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true },
);

userNftSchema.index({ ownerTgUserId: 1, marketStatus: 1, updatedAt: -1 });
userNftSchema.index({ marketStatus: 1, listedAt: -1, updatedAt: -1 });

module.exports = mongoose.model("UserNft", userNftSchema);
