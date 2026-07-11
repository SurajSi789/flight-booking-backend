const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const User = require("../models/User");
const { createRedisClient } = require("../config/redis");
const { env } = require("../config/env");
const EmailService = require("../services/EmailService");

const redis = createRedisClient();
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const RESET_TOKEN_TTL_SECONDS = 30 * 60;
// Window a user has to complete email verification. Also governs when the TTL
// index purges an abandoned unverified signup so the email can be reused.
const VERIFICATION_TTL_MINUTES = 15;
// Max wrong OTP guesses before the code is invalidated and must be re-requested.
const MAX_OTP_ATTEMPTS = 5;

const hashSha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const setRefreshCookie = (res, refreshToken) => {
  const crossOrigin = env.nodeEnv !== "development";
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    sameSite: crossOrigin ? "none" : "strict",
    secure: crossOrigin, // SameSite=None requires Secure=true
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000
  });
};

const clearRefreshCookie = (res) => {
  const crossOrigin = env.nodeEnv !== "development";
  res.clearCookie("refreshToken", {
    httpOnly: true,
    sameSite: crossOrigin ? "none" : "strict",
    secure: crossOrigin
  });
};

const buildUserPayload = (user) => ({
  id: user._id,
  name: `${user.name.first} ${user.name.last}`,
  firstName: user.name.first,
  lastName: user.name.last,
  email: user.email,
  role: user.role,
  loginType: user.loginType || "user",
  phone: user.phone || null,
  employeeId: user.employeeId || null,
  company: user.company || null,
});

const issueTokens = async (user) => {
  const jti = uuidv4();
  const accessToken = jwt.sign(
    {
      userId: user._id.toString(),
      role: user.role,
      email: user.email,
      tokenVersion: user.tokenVersion || 0,
      jti
    },
    env.jwtAccessSecret,
    { expiresIn: "15m" }
  );

  const refreshToken = jwt.sign(
    {
      userId: user._id.toString(),
      tokenVersion: user.tokenVersion || 0
    },
    env.jwtRefreshSecret,
    { expiresIn: "7d" }
  );

  user.refreshTokenHash = hashSha256(refreshToken);
  await user.save();

  return { accessToken, refreshToken };
};

const buildVerifyLink = (token) =>
  `${env.appBaseUrl.replace(/\/$/, "")}/verify-email?token=${token}`;

const register = async (req, res) => {
  const { name, email, phone, password } = req.body;
  const passwordHash = await bcrypt.hash(password, 12);

  // Reuse an existing UNVERIFIED record instead of hard-failing: a user who
  // abandoned the OTP step must be able to start over with the same email.
  // Only a fully verified account blocks re-registration.
  const existing = await User.findByEmail(email).select("+otpHash +verifyTokenHash");
  let user;
  if (existing) {
    if (existing.isVerified) {
      return res.status(409).json({ success: false, message: "Email already registered" });
    }
    existing.name = name;
    existing.phone = phone;
    existing.passwordHash = passwordHash;
    user = existing;
  } else {
    user = new User({ name, email, phone, passwordHash, isVerified: false });
  }

  const { otp, token } = user.issueVerificationChallenge(VERIFICATION_TTL_MINUTES);
  await user.save();
  await redis.del(`otp-attempts:${user._id}`); // fresh code → reset guess counter

  await EmailService.sendOTPEmail({
    to: user.email,
    otp,
    name: `${user.name.first} ${user.name.last}`,
    verifyLink: buildVerifyLink(token),
    expiryMinutes: VERIFICATION_TTL_MINUTES
  });

  // If no email transport is configured (e.g. local dev without SMTP/Brevo),
  // auto-verify so developers aren't stranded. When email IS configured the
  // real OTP/link flow runs, in every environment.
  if (!EmailService.isConfigured()) {
    user.isVerified = true;
    user.clearVerificationChallenge();
    await user.save();
  }

  return res.status(201).json({
    success: true,
    message: "OTP sent to email",
    data: { userId: user._id, expiresAt: user.verificationExpiresAt }
  });
};

const verifyOtp = async (req, res) => {
  const { userId, otp } = req.body;
  const user = await User.findById(userId).select("+otpHash +verifyTokenHash +refreshTokenHash");
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  if (!user.otpHash || !user.otpExpiry || user.otpExpiry < new Date()) {
    return res.status(400).json({ success: false, message: "OTP expired or unavailable" });
  }

  const attemptsKey = `otp-attempts:${user._id}`;
  const otpHash = hashSha256(otp);
  if (otpHash !== user.otpHash) {
    // Cap wrong guesses so the 6-digit code can't be brute-forced in its window.
    const attempts = await redis.incr(attemptsKey);
    if (attempts === 1) {
      await redis.expire(attemptsKey, VERIFICATION_TTL_MINUTES * 60);
    }
    if (attempts >= MAX_OTP_ATTEMPTS) {
      user.otpHash = undefined;
      user.otpExpiry = undefined;
      await user.save();
      return res.status(429).json({
        success: false,
        message: "Too many incorrect attempts. Please request a new code."
      });
    }
    return res.status(400).json({ success: false, message: "Invalid OTP" });
  }

  await redis.del(attemptsKey);
  user.isVerified = true;
  user.clearVerificationChallenge();
  user.lastLoginAt = new Date();

  const { accessToken, refreshToken } = await issueTokens(user);
  setRefreshCookie(res, refreshToken);

  return res.json({
    success: true,
    message: "OTP verified successfully",
    data: {
      accessToken,
      user: buildUserPayload(user)
    }
  });
};

const verifyEmail = async (req, res) => {
  const { token } = req.body;
  const tokenHash = hashSha256(token);
  const user = await User.findOne({ verifyTokenHash: tokenHash }).select(
    "+verifyTokenHash +refreshTokenHash"
  );
  if (!user) {
    return res.status(400).json({ success: false, message: "Invalid or expired verification link" });
  }
  if (user.isVerified) {
    return res.status(400).json({ success: false, message: "Account is already verified. Please log in." });
  }
  if (!user.verificationExpiresAt || user.verificationExpiresAt < new Date()) {
    return res.status(400).json({ success: false, message: "Verification link expired. Please sign up again." });
  }

  user.isVerified = true;
  user.clearVerificationChallenge();
  user.lastLoginAt = new Date();

  const { accessToken, refreshToken } = await issueTokens(user);
  setRefreshCookie(res, refreshToken);

  return res.json({
    success: true,
    message: "Email verified successfully",
    data: {
      accessToken,
      user: buildUserPayload(user)
    }
  });
};

const login = async (req, res) => {
  const { email, password, loginType, employeeId } = req.body;

  let user;
  if (loginType === "corporate" && employeeId) {
    user = await User.findOne({ employeeId: String(employeeId).trim() }).select("+passwordHash +refreshTokenHash");
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ success: false, message: "Invalid employee ID or password" });
    }
  } else {
    user = await User.findByEmail(email).select("+passwordHash +refreshTokenHash");
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }
  }
  if (!user.isVerified) {
    return res.status(403).json({ success: false, message: "Please verify OTP before login" });
  }
  if (!user.isActive) {
    return res.status(403).json({ success: false, message: "User account is inactive" });
  }

  user.lastLoginAt = new Date();
  const { accessToken, refreshToken } = await issueTokens(user);
  setRefreshCookie(res, refreshToken);

  return res.json({
    success: true,
    message: "Login successful",
    data: {
      accessToken,
      user: buildUserPayload(user)
    }
  });
};

const allowedOrigins = new Set([
  ...env.corsWhitelist,
  ...(env.adminCorsOrigin ? [env.adminCorsOrigin] : [])
]);

const refresh = async (req, res) => {
  // CSRF defense-in-depth: the refresh cookie is SameSite=None in production, so
  // reject cross-site callers by Origin. (CORS preflight already blocks JSON
  // POSTs from unknown origins; this also stops "simple" form-encoded POSTs.)
  const origin = req.headers.origin;
  if (origin && allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
    return res.status(403).json({ success: false, message: "Origin not allowed" });
  }

  const refreshToken = req.cookies?.refreshToken;
  if (!refreshToken) {
    return res.status(401).json({ success: false, message: "Refresh token cookie not found" });
  }

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, env.jwtRefreshSecret);
  } catch (error) {
    return res.status(401).json({ success: false, message: "Invalid or expired refresh token" });
  }

  const user = await User.findById(decoded.userId).select("+refreshTokenHash");
  if (!user) {
    return res.status(401).json({ success: false, message: "User not found for refresh token" });
  }
  if ((user.tokenVersion || 0) !== decoded.tokenVersion) {
    return res.status(401).json({ success: false, message: "Refresh token invalidated" });
  }
  if (!user.refreshTokenHash || user.refreshTokenHash !== hashSha256(refreshToken)) {
    return res.status(401).json({ success: false, message: "Refresh token mismatch" });
  }

  const { accessToken, refreshToken: rotatedRefreshToken } = await issueTokens(user);
  setRefreshCookie(res, rotatedRefreshToken);

  return res.json({
    success: true,
    message: "Token refreshed",
    data: { accessToken }
  });
};

const logout = async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ success: false, message: "Missing Bearer token" });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, env.jwtAccessSecret);
  } catch (error) {
    return res.status(401).json({ success: false, message: "Invalid or expired access token" });
  }

  const ttlSeconds = Math.max(1, (decoded.exp || 0) - Math.floor(Date.now() / 1000));
  if (decoded.jti) {
    await redis.set(`blacklist:${decoded.jti}`, "1", "EX", ttlSeconds);
  }

  await User.findByIdAndUpdate(decoded.userId, { $set: { refreshTokenHash: null } });
  clearRefreshCookie(res);

  return res.json({ success: true, message: "Logged out" });
};

const resendOtp = async (req, res) => {
  const { userId } = req.body;
  const user = await User.findById(userId).select("+otpHash +verifyTokenHash");
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  if (user.isVerified) {
    return res.status(400).json({ success: false, message: "User is already verified" });
  }

  const rateKey = `otp-resend:${user._id}`;
  const count = await redis.incr(rateKey);
  if (count === 1) {
    await redis.expire(rateKey, 60 * 60);
  }
  if (count > 3) {
    return res.status(429).json({
      success: false,
      message: "OTP resend limit reached. Try again later."
    });
  }

  const { otp, token } = user.issueVerificationChallenge(VERIFICATION_TTL_MINUTES);
  await user.save();
  await redis.del(`otp-attempts:${user._id}`); // fresh code → reset guess counter
  await EmailService.sendOTPEmail({
    to: user.email,
    otp,
    name: `${user.name.first} ${user.name.last}`,
    verifyLink: buildVerifyLink(token),
    expiryMinutes: VERIFICATION_TTL_MINUTES
  });

  return res.json({
    success: true,
    message: "OTP resent to email",
    data: { expiresAt: user.verificationExpiresAt }
  });
};

const forgotPassword = async (req, res) => {
  const { email } = req.body;
  const user = await User.findByEmail(email);
  // Product decision: surface unknown emails explicitly (nudge to sign up) rather
  // than the generic "if it exists" message. Note this permits email enumeration.
  if (!user) {
    return res.status(404).json({
      success: false,
      message: "This email is not registered with us. Please sign up."
    });
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashSha256(rawToken);
  await redis.set(`reset:${tokenHash}`, user._id.toString(), "EX", RESET_TOKEN_TTL_SECONDS);

  const resetLink = `${env.appBaseUrl.replace(/\/$/, "")}/reset-password?token=${rawToken}`;
  await EmailService.sendPasswordResetEmail({ to: user.email, resetLink });

  return res.json({
    success: true,
    message: "Password reset link sent to your email"
  });
};

const resetPassword = async (req, res) => {
  const { token, newPassword } = req.body;
  const tokenHash = hashSha256(token);
  const userId = await redis.get(`reset:${tokenHash}`);

  if (!userId) {
    return res.status(400).json({ success: false, message: "Invalid or expired reset token" });
  }

  const user = await User.findById(userId).select("+refreshTokenHash");
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.refreshTokenHash = null;
  await user.save();
  await redis.del(`reset:${tokenHash}`);

  return res.json({ success: true, message: "Password reset successful" });
};

module.exports = {
  register,
  verifyOtp,
  verifyEmail,
  login,
  refresh,
  logout,
  resendOtp,
  forgotPassword,
  resetPassword
};
