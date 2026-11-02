const mongoose = require("mongoose");

const broadcastDeliverySchema = new mongoose.Schema(
  {
    broadcastId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Broadcast",
      required: true,
      index: true,
    },
    tgUserId: { type: String, required: true, index: true },
    messageId: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pending", "processing", "sent", "failed", "deleted"],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
    sentAt: { type: Date, default: null },
    lockUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

broadcastDeliverySchema.index(
  { broadcastId: 1, tgUserId: 1 },
  { unique: true },
);

module.exports = mongoose.model("BroadcastDelivery", broadcastDeliverySchema);
