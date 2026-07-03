const mongoose = require("mongoose");

const { Schema } = mongoose;

const securityDeviceEventSchema = new Schema(
  {
    tgUserId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    username: {
      type: String,
      default: "",
      trim: true,
    },
    profileName: {
      type: String,
      default: "",
      trim: true,
    },
    deviceKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    deviceFingerprint: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    deviceId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    ip: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    userAgent: {
      type: String,
      default: "",
      trim: true,
    },
    firstSeenAt: {
      type: Date,
      default: null,
    },
    lastSeenAt: {
      type: Date,
      default: null,
    },
    requestCount: {
      type: Number,
      default: 0,
    },
    uniqueUserCount: {
      type: Number,
      default: 0,
    },
    uniqueUserIds: {
      type: [String],
      default: [],
      select: false,
    },
    recentEvents: {
      type: [
        {
          tgUserId: {
            type: String,
            default: "",
            trim: true,
          },
          username: {
            type: String,
            default: "",
            trim: true,
          },
          profileName: {
            type: String,
            default: "",
            trim: true,
          },
          ip: {
            type: String,
            default: "",
            trim: true,
          },
          userAgent: {
            type: String,
            default: "",
            trim: true,
          },
          route: {
            type: String,
            default: "",
            trim: true,
          },
          method: {
            type: String,
            default: "",
            trim: true,
          },
          seenAt: {
            type: Date,
            default: null,
          },
        },
      ],
      default: [],
      select: false,
    },
    suspiciousAt: {
      type: Date,
      default: null,
    },
    suspiciousReason: {
      type: String,
      default: "",
      trim: true,
    },
    alertCount: {
      type: Number,
      default: 0,
    },
    lastAlertAt: {
      type: Date,
      default: null,
    },
    lastAlertMilestone: {
      type: Number,
      default: 0,
    },
    latestRoute: {
      type: String,
      default: "",
      trim: true,
    },
    latestMethod: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true },
);

securityDeviceEventSchema.index({ lastSeenAt: -1 });
securityDeviceEventSchema.index({ suspiciousAt: -1, lastSeenAt: -1 });

module.exports = mongoose.model(
  "SecurityDeviceActivity",
  securityDeviceEventSchema,
);
