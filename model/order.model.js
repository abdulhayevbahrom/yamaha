const mongoose = require("mongoose");

const { Schema } = mongoose;

const orderSchema = new Schema(
  {
    orderId: {
      type: Number,
      required: true,
      unique: true
    },
    product: {
      type: String,
      enum: ["star", "premium", "uc", "balance"],
      required: true
    },
    planCode: {
      type: String,
      required: true
    },
    customAmount: {
      type: Number,
      default: 0
    },
    username: {
      type: String,
      required: true
    },
    tgUserId: {
      type: String,
      default: ""
    },
    tgUsername: {
      type: String,
      default: ""
    },
    profileName: {
      type: String,
      default: ""
    },
    paymentMethod: {
      type: String,
      enum: ["card", "uzumbank", "paynet", "click", "balance"],
      default: "card"
    },
    expectedAmount: {
      type: Number,
      required: true
    },
    paidAmount: {
      type: Number,
      default: 0
    },
    paidAt: {
      type: Date,
      default: null
    },
    status: {
      type: String,
      enum: [
        "pending_payment",
        "payment_submitted",
        "paid_auto_processed",
        "completed",
        "cancelled",
        "failed"
      ],
      default: "pending_payment"
    },
    fulfillmentStatus: {
      type: String,
      enum: ["pending", "processing", "success", "failed", "skipped"],
      default: "pending"
    },
    fulfillmentError: {
      type: String,
      default: ""
    },
    tonAmount: {
      type: Number,
      default: 0
    },
    fragmentTx: {
      type: Schema.Types.Mixed,
      default: null
    },
    fulfillmentStartedAt: {
      type: Date,
      default: null
    },
    fulfilledAt: {
      type: Date,
      default: null
    },
    archiveSentAt: {
      type: Date,
      default: null
    },
    expiresAt: {
      type: Date,
      default: null
    },
    sequence: {
      type: Number,
      required: true
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);
