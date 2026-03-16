const mongoose = require("mongoose");

const broadcastSchema = new mongoose.Schema(
  {
    adminChatId: { type: String, required: true },
    type: {
      type: String,
      enum: ["text", "photo", "forward"],
      required: true,
    },
    text: { type: String, default: "" },
    photoFileId: { type: String, default: "" },
    sourceChatId: { type: String, default: "" },
    sourceMessageId: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Broadcast", broadcastSchema);
