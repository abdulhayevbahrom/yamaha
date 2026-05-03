const bcrypt = require("bcryptjs");

const rawPassword = String(process.argv[2] || "").trim();

if (!rawPassword) {
  console.error("Usage: node scripts/admin-password-hash.js <plain-password>");
  process.exit(1);
}

const saltRounds = 12;
const hash = bcrypt.hashSync(rawPassword, saltRounds);
console.log(hash);
