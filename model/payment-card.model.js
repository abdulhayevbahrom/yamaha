const mongoose = require("mongoose");

const { Schema } = mongoose;

const paymentCardSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["purchase", "balance_topup"],
      required: true,
      index: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    cardNumber: {
      type: String,
      required: true,
      trim: true,
    },
    cardHolder: {
      type: String,
      required: true,
      trim: true,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    dailyUsageResetAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

paymentCardSchema.index({ type: 1, isActive: 1, sortOrder: 1, createdAt: 1 });

module.exports = mongoose.model("PaymentCard", paymentCardSchema);
