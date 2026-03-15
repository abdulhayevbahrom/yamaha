const mongoose = require("mongoose");

let isConnected = false;

const connectDB = async () => {
  if (isConnected) return;
  if (!process.env.MONGO_URI) {
    console.warn("MONGO_URI topilmadi, backend DBsiz ishga tushdi.");
    return;
  }

  try {
    const db = await mongoose.connect(process.env.MONGO_URI);
    isConnected = db.connections[0].readyState;
    console.log("MongoDBga muvaffaqiyatli ulanildi ✅✅✅");
  } catch (error) {
    console.error("MongoDB ulanish xatosi ❌❌❌:", error);
    throw error;
  }
};

module.exports = connectDB;
