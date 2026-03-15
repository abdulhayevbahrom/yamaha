const Counter = require("../model/counter.model");

async function getNextOrderId() {
  const counter = await Counter.findOneAndUpdate(
    { name: "order" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  ).lean();
  return counter.seq;
}

module.exports = { getNextOrderId };
