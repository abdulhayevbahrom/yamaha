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
      enum: ["star", "premium", "uc", "freefire", "mlbb", "balance", "star_sell", "nft_withdrawal"],
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
    playerId: {
      type: String,
      default: ""
    },
    zoneId: {
      type: String,
      default: ""
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
    paymentCardId: {
      type: Schema.Types.ObjectId,
      ref: "PaymentCard",
      default: null
    },
    paymentCardSnapshot: {
      type: new Schema(
        {
          type: {
            type: String,
            enum: ["purchase", "balance_topup"],
            default: "purchase"
          },
          label: {
            type: String,
            default: ""
          },
          cardNumber: {
            type: String,
            default: ""
          },
          cardHolder: {
            type: String,
            default: ""
          },
          notes: {
            type: String,
            default: ""
          },
          isFallback: {
            type: Boolean,
            default: false
          }
        },
        { _id: false }
      ),
      default: null
    },
    paymentMethod: {
      type: String,
      enum: ["card", "bankomat", "uzumbank", "paynet", "click", "balance", "stars"],
      default: "card"
    },
    sellCardNumber: {
      type: String,
      default: ""
    },
    sellPricePerStar: {
      type: Number,
      default: 0
    },
    starsAmount: {
      type: Number,
      default: 0
    },
    starsInvoicePayload: {
      type: String,
      default: ""
    },
    starsInvoiceLink: {
      type: String,
      default: ""
    },
    starsTelegramChargeId: {
      type: String,
      default: ""
    },
    paymentGrossAmount: {
      type: Number,
      default: 0
    },
    balanceCreditAmount: {
      type: Number,
      default: 0
    },
    paymentFeePercent: {
      type: Number,
      default: 0
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
    referralReferrerUserId: {
      type: String,
      default: ""
    },
    referralCommissionAmount: {
      type: Number,
      default: 0
    },
    referralCommissionPercent: {
      type: Number,
      default: 0
    },
    referralCommissionAwardedAt: {
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
    completionMode: {
      type: String,
      enum: ["manual", "auto", ""],
      default: ""
    },
    fulfillmentError: {
      type: String,
      default: ""
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

orderSchema.index({ paymentCardId: 1, createdAt: 1, status: 1 });
orderSchema.index({ status: 1, expiresAt: 1 });
orderSchema.index({ tgUserId: 1, createdAt: -1 });
orderSchema.index({ status: 1, expectedAmount: 1, expiresAt: 1, createdAt: 1 });
orderSchema.index({ product: 1, status: 1, paidAt: -1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Order", orderSchema);
