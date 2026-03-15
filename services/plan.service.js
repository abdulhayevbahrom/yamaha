// const Plan = require("../model/plan.model");

// const defaultPlans = [
//   { category: "star", code: "50", label: "50 Star", amount: 50, basePrice: 9000 },
//   { category: "star", code: "100", label: "100 Star", amount: 100, basePrice: 17000 },
//   { category: "star", code: "250", label: "250 Star", amount: 250, basePrice: 40000 },
//   { category: "star", code: "500", label: "500 Star", amount: 500, basePrice: 75000 },
//   { category: "star", code: "1000", label: "1000 Star", amount: 1000, basePrice: 140000 },
//   { category: "premium", code: "1m", label: "1 Oy", amount: 1, basePrice: 29000 },
//   { category: "premium", code: "3m", label: "3 Oy", amount: 3, basePrice: 79000 },
//   { category: "premium", code: "6m", label: "6 Oy", amount: 6, basePrice: 145000 },
//   { category: "uc", code: "60", label: "60 UC", amount: 60, basePrice: 10000 },
//   { category: "uc", code: "325", label: "325 UC", amount: 325, basePrice: 50000 },
//   { category: "uc", code: "660", label: "660 UC", amount: 660, basePrice: 95000 },
//   { category: "uc", code: "1800", label: "1800 UC", amount: 1800, basePrice: 255000 },
//   { category: "uc", code: "3850", label: "3850 UC", amount: 3850, basePrice: 510000 },
//   { category: "uc", code: "8100", label: "8100 UC", amount: 8100, basePrice: 1000000 }
// ];

// let seeded = false;

// async function ensureDefaultPlans() {
//   if (seeded) return;
//   const count = await Plan.countDocuments();
//   if (count === 0) {
//     await Plan.insertMany(defaultPlans);
//   }
//   seeded = true;
// }

// module.exports = { ensureDefaultPlans };
