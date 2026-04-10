const mongoose = require("mongoose");

const nftOfferSchema = new mongoose.Schema(
  {
    nftId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    sellerTgUserId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    sellerUsername: {
      type: String,
      default: "",
      trim: true,
    },
    sellerProfileName: {
      type: String,
      default: "",
      trim: true,
    },
    buyerTgUserId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    buyerUsername: {
      type: String,
      default: "",
      trim: true,
    },
    buyerProfileName: {
      type: String,
      default: "",
      trim: true,
    },
    listingPriceUzs: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    offeredPriceUzs: {
      type: Number,
      required: true,
      min: 1,
    },
    offerDurationDays: {
      type: Number,
      required: true,
      min: 1,
      max: 30,
      default: 3,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "cancelled", "expired"],
      default: "pending",
      index: true,
    },
    respondedAt: {
      type: Date,
      default: null,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    rejectedAt: {
      type: Date,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    expiredAt: {
      type: Date,
      default: null,
    },
    cancelReason: {
      type: String,
      default: "",
      trim: true,
    },
    responseNote: {
      type: String,
      default: "",
      trim: true,
      maxlength: 280,
    },
  },
  { timestamps: true },
);

nftOfferSchema.index({ sellerTgUserId: 1, status: 1, createdAt: -1 });
nftOfferSchema.index({ buyerTgUserId: 1, createdAt: -1 });
nftOfferSchema.index({ buyerTgUserId: 1, nftId: 1, createdAt: -1 });
nftOfferSchema.index({ nftId: 1, status: 1, createdAt: -1 });
nftOfferSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model("NftOffer", nftOfferSchema);
