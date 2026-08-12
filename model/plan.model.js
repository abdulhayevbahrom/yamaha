const mongoose = require("mongoose");

const planSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      enum: ["star", "premium", "uc", "freefire", "mlbb"],
      required: true
    },
    code: {
      type: String,
      required: true,
      trim: true
    },
    label: {
      type: String,
      required: true,
      trim: true
    },
    amount: {
      type: Number,
      required: true
    },
    basePrice: {
      type: Number,
      required: true
    },
    currency: {
      type: String,
      default: "UZS"
    },
    isActive: {
      type: Boolean,
      default: true
    },
    provider: {
      type: String,
      enum: ["manual", "gw"],
      default: "manual"
    },
    providerProductId: {
      type: String,
      default: "",
      trim: true
    },
    providerPriceUsd: {
      type: Number,
      default: 0
    },
    providerAvailable: {
      type: Boolean,
      default: true
    },
    providerSyncedAt: {
      type: Date,
      default: null
    },
    providerUpdatedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

planSchema.index({ category: 1, code: 1 }, { unique: true });
planSchema.index(
  { provider: 1, providerProductId: 1 },
  {
    unique: true,
    partialFilterExpression: { provider: "gw" }
  }
);

module.exports = mongoose.model("Plan", planSchema);
