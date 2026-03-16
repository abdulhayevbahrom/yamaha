const mongoose = require("mongoose");

const deliverySchema = new mongoose.Schema(
  {
    broadcastId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Broadcast",
      required: true,
      index: true,
    },
    tgUserId: { type: String, required: true, index: true },
    messageId: { type: Number, required: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("BroadcastDelivery", deliverySchema);
