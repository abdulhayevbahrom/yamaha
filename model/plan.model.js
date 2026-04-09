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
    }
  },
  { timestamps: true }
);

planSchema.index({ category: 1, code: 1 }, { unique: true });

module.exports = mongoose.model("Plan", planSchema);
