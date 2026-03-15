const mongoose = require("mongoose");

const paymentLogSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      default: "cardxabar"
    },
    externalMessageId: {
      type: String,
      default: null
    },
    amount: {
      type: Number,
      default: 0
    },
    rawText: {
      type: String,
      default: ""
    },
    matchedOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null
    },
    status: {
      type: String,
      enum: ["matched", "unmatched", "duplicate", "invalid"],
      default: "invalid"
    }
  },
  { timestamps: true }
);

paymentLogSchema.index(
  { source: 1, externalMessageId: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model("PaymentLog", paymentLogSchema);
