const mongoose = require("mongoose");

const broadcastSchema = new mongoose.Schema(
  {
    adminChatId: { type: String, required: true },
    type: {
      type: String,
      enum: ["text", "photo", "video", "document"],
      default: "text",
    },
    text: { type: String, default: "" },
    fileId: { type: String, default: "" },
    // Kept for backwards compatibility with broadcasts created before fileId.
    photoFileId: { type: String, default: "" },
    fileName: { type: String, default: "" },
    entities: { type: [mongoose.Schema.Types.Mixed], default: [] },
    captionEntities: { type: [mongoose.Schema.Types.Mixed], default: [] },
    buttons: {
      type: [[{
        text: { type: String },
        url: { type: String },
        web_app: { url: { type: String } },
      }]],
      default: [],
    },
    status: {
      type: String,
      enum: ["draft", "scheduled", "processing", "completed", "cancelled", "deleting", "deleted", "failed"],
      default: "draft",
      index: true,
    },
    draftStage: {
      type: String,
      enum: ["content", "buttons", "button_name", "button_target", "external_url", "schedule", ""],
      default: "content",
    },
    draftButtonText: { type: String, default: "" },
    scheduledAt: { type: Date, default: null, index: true },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lockUntil: { type: Date, default: null },
    totalCount: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
  },
  { timestamps: true },
);

broadcastSchema.index({ status: 1, scheduledAt: 1 });
broadcastSchema.index({ adminChatId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model("Broadcast", broadcastSchema);
