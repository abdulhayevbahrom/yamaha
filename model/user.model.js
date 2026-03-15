const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    tgUserId: {
      type: String,
      required: true,
      unique: true,
    },
    username: {
      type: String,
      default: "",
    },
    firstName: {
      type: String,
      default: "",
    },
    lastName: {
      type: String,
      default: "",
    },
    balance: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("User", userSchema);
