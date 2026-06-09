/**
 * One-time script to create the first super_admin account.
 *
 * Usage:
 *   ADMIN_EMAIL=you@company.com ADMIN_PASSWORD=YourStr0ngPass! node scripts/seed-admin.js
 *
 * The script is idempotent — running it twice with the same email is safe.
 */

const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Validate required env before importing anything that needs them
const missing = ["MONGO_URI", "ADMIN_JWT_SECRET"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[seed-admin] Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const mongoose = require("mongoose");
const AdminUser = require("../src/models/AdminUser");

const email    = process.env.ADMIN_EMAIL    || "admin@skybook.internal";
const password = process.env.ADMIN_PASSWORD || null;
const name     = process.env.ADMIN_NAME     || "Super Admin";

if (!password) {
  console.error("[seed-admin] Set ADMIN_PASSWORD env var (min 12 chars)");
  process.exit(1);
}

if (password.length < 12) {
  console.error("[seed-admin] ADMIN_PASSWORD must be at least 12 characters");
  process.exit(1);
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[seed-admin] Connected to MongoDB");

  const existing = await AdminUser.findOne({ email });
  if (existing) {
    console.log(`[seed-admin] Admin already exists: ${email} (role: ${existing.adminRole})`);
    console.log("[seed-admin] To reset password, update it directly in the database.");
    await mongoose.disconnect();
    return;
  }

  const admin = await AdminUser.create({
    name,
    email,
    passwordHash: password,  // pre-save hook hashes it
    adminRole:    "super_admin",
  });

  console.log("✓ Super admin created:");
  console.log(`  Email:     ${admin.email}`);
  console.log(`  Name:      ${admin.name}`);
  console.log(`  Role:      ${admin.adminRole}`);
  console.log(`  ID:        ${admin._id}`);
  console.log("");
  console.log("Next: enable 2FA via POST /api/v1/admin/auth/mfa/setup after first login.");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("[seed-admin] Error:", err.message);
  process.exit(1);
});
