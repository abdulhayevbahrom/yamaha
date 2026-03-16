const mongoose = require("mongoose");

const broadcastSchema = new mongoose.Schema(
  {
    adminChatId: { type: String, required: true },
    type: { type: String, enum: ["text", "photo"], required: true },
    text: { type: String, default: "" },
    photoFileId: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Broadcast", broadcastSchema);
