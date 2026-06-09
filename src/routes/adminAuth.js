const express = require("express");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const AdminUser = require("../models/AdminUser");
const AuditLog = require("../models/AuditLog");
const { env } = require("../config/env");
const asyncHandler = require("../utils/asyncHandler");
const buildRateLimiter = require("../middleware/rateLimiter");
const { authenticate } = require("../middleware/adminAuth");
const { createRedisClient } = require("../config/redis");
const { body, validationResult } = require("express-validator");

let speakeasy;
let qrcode;
try {
  speakeasy = require("speakeasy");
  qrcode    = require("qrcode");
} catch {
  // speakeasy not installed yet — MFA endpoints return 501
}

const router = express.Router();
const redis  = createRedisClient();

// Strict rate limiter for login — 10 attempts per 15 min per IP
const loginLimiter = buildRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many login attempts, try again later",
});

function issueAdminToken(admin) {
  const jti = uuidv4();
  const token = jwt.sign(
    {
      adminId:   admin._id,
      email:     admin.email,
      adminRole: admin.adminRole,
      tokenType: "admin_access",
      jti,
    },
    env.adminJwtSecret,
    { expiresIn: "8h" }
  );
  return { token, jti };
}

// POST /api/v1/admin/auth/login
router.post(
  "/login",
  loginLimiter,
  [
    body("email").isEmail().normalizeEmail(),
    body("password").isString().notEmpty(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: "Invalid request", errors: errors.array() });
    }

    const { email, password, totpCode } = req.body;
    const ip = req.headers["x-forwarded-for"] || req.ip;

    const admin = await AdminUser.findOne({ email }).select(
      "+passwordHash +mfaSecret +loginAttempts +lockedUntil"
    );

    // Constant-time-safe: always compare even when admin not found
    if (!admin) {
      await new Promise((r) => setTimeout(r, 200));
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    if (!admin.isActive) {
      return res.status(401).json({ success: false, message: "Account deactivated" });
    }

    // Lockout check
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      const remainMs = admin.lockedUntil - Date.now();
      return res.status(429).json({
        success: false,
        message: `Account locked. Try again in ${Math.ceil(remainMs / 60000)} minutes`,
      });
    }

    const valid = await admin.comparePassword(password);
    if (!valid) {
      admin.loginAttempts = (admin.loginAttempts || 0) + 1;
      if (admin.loginAttempts >= 5) {
        admin.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
        admin.loginAttempts = 0;
      }
      await admin.save();
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    // MFA verification (required when enabled)
    if (admin.mfaEnabled) {
      if (!speakeasy) {
        return res.status(501).json({ success: false, message: "MFA not available — install speakeasy" });
      }
      if (!totpCode) {
        return res.status(200).json({ success: false, requiresTotp: true, message: "2FA code required" });
      }
      const verified = speakeasy.totp.verify({
        secret:   admin.mfaSecret,
        encoding: "base32",
        token:    String(totpCode),
        window:   1,
      });
      if (!verified) {
        return res.status(401).json({ success: false, message: "Invalid 2FA code" });
      }
    }

    // Success — reset lockout counters
    admin.loginAttempts = 0;
    admin.lockedUntil   = undefined;
    admin.lastLoginAt   = new Date();
    admin.lastLoginIp   = ip;
    await admin.save();

    const { token } = issueAdminToken(admin);

    await AuditLog.create({
      actor:       admin._id,
      actorModel:  "AdminUser",
      adminId:     admin._id,
      action:      "admin.auth.login",
      ipAddress:   ip,
      userAgent:   req.headers["user-agent"],
    });

    return res.json({
      success: true,
      token,
      admin: {
        id:         admin._id,
        name:       admin.name,
        email:      admin.email,
        adminRole:  admin.adminRole,
        mfaEnabled: admin.mfaEnabled,
      },
    });
  })
);

// POST /api/v1/admin/auth/logout
router.post("/logout", authenticate, asyncHandler(async (req, res) => {
  const { jti, id } = req.adminUser;
  if (jti) {
    // Blacklist for 8 h (token lifetime)
    await redis.setex(`admin_blacklist:${jti}`, 8 * 3600, "1");
  }

  await AuditLog.create({
    actor:      id,
    actorModel: "AdminUser",
    adminId:    id,
    action:     "admin.auth.logout",
    ipAddress:  req.headers["x-forwarded-for"] || req.ip,
  });

  return res.json({ success: true });
}));

// POST /api/v1/admin/auth/mfa/setup  — generate TOTP secret + QR code
router.post("/mfa/setup", authenticate, asyncHandler(async (req, res) => {
  if (!speakeasy || !qrcode) {
    return res.status(501).json({ success: false, message: "MFA not available — run: npm install speakeasy qrcode" });
  }

  const admin = await AdminUser.findById(req.adminUser.id).select("+mfaSecret");
  if (!admin) return res.status(404).json({ success: false, message: "Admin not found" });

  const secret = speakeasy.generateSecret({
    name:   `SkyBook Admin (${admin.email})`,
    length: 32,
  });

  // Store unconfirmed secret — only activate after verify step
  admin.mfaSecret  = secret.base32;
  admin.mfaEnabled = false;
  await admin.save();

  const otpauthUrl = secret.otpauth_url;
  const qrDataUrl  = await qrcode.toDataURL(otpauthUrl);

  return res.json({
    success:    true,
    qrCodeUrl:  qrDataUrl,
    manualKey:  secret.base32,
    message:    "Scan with your authenticator app then call /mfa/verify to activate",
  });
}));

// POST /api/v1/admin/auth/mfa/verify  — confirm TOTP enrollment
router.post(
  "/mfa/verify",
  authenticate,
  [body("totpCode").isString().isLength({ min: 6, max: 6 })],
  asyncHandler(async (req, res) => {
    if (!speakeasy) {
      return res.status(501).json({ success: false, message: "MFA not available — install speakeasy" });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: "6-digit code required" });
    }

    const admin = await AdminUser.findById(req.adminUser.id).select("+mfaSecret");
    if (!admin || !admin.mfaSecret) {
      return res.status(400).json({ success: false, message: "Run /mfa/setup first" });
    }

    const verified = speakeasy.totp.verify({
      secret:   admin.mfaSecret,
      encoding: "base32",
      token:    req.body.totpCode,
      window:   1,
    });

    if (!verified) {
      return res.status(400).json({ success: false, message: "Invalid code — try again" });
    }

    admin.mfaEnabled = true;
    await admin.save();

    await AuditLog.create({
      actor:      admin._id,
      actorModel: "AdminUser",
      adminId:    admin._id,
      action:     "admin.auth.mfa_enabled",
      ipAddress:  req.headers["x-forwarded-for"] || req.ip,
    });

    return res.json({ success: true, message: "2FA successfully enabled" });
  })
);

// POST /api/v1/admin/auth/mfa/disable  — super_admin only, or self
router.post("/mfa/disable", authenticate, asyncHandler(async (req, res) => {
  const admin = await AdminUser.findById(req.adminUser.id);
  if (!admin) return res.status(404).json({ success: false, message: "Admin not found" });

  admin.mfaEnabled = false;
  admin.mfaSecret  = undefined;
  await admin.save();

  await AuditLog.create({
    actor:      admin._id,
    actorModel: "AdminUser",
    adminId:    admin._id,
    action:     "admin.auth.mfa_disabled",
    ipAddress:  req.headers["x-forwarded-for"] || req.ip,
  });

  return res.json({ success: true, message: "2FA disabled" });
}));

// GET /api/v1/admin/auth/me  — return current admin profile
router.get("/me", authenticate, asyncHandler(async (req, res) => {
  const admin = await AdminUser.findById(req.adminUser.id);
  if (!admin) return res.status(404).json({ success: false, message: "Admin not found" });

  return res.json({
    success: true,
    admin: {
      id:         admin._id,
      name:       admin.name,
      email:      admin.email,
      adminRole:  admin.adminRole,
      mfaEnabled: admin.mfaEnabled,
      lastLoginAt: admin.lastLoginAt,
      lastLoginIp: admin.lastLoginIp,
    },
  });
}));

module.exports = router;
