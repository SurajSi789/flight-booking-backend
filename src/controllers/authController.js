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

const hashSha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const setRefreshCookie = (res, refreshToken) => {
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    sameSite: "strict",
    secure: env.nodeEnv === "production",
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000
  });
};

const clearRefreshCookie = (res) => {
  res.clearCookie("refreshToken", {
    httpOnly: true,
    sameSite: "strict",
    secure: env.nodeEnv === "production"
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

const register = async (req, res) => {
  const { name, email, phone, password } = req.body;
  const existing = await User.findByEmail(email);
  if (existing) {
    return res.status(409).json({ success: false, message: "Email already registered" });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = new User({
    name,
    email,
    phone,
    passwordHash,
    isVerified: false
  });

  const otp = user.generateOTP(10);
  await user.save();

  await EmailService.sendOTPEmail({
    to: user.email,
    otp,
    name: `${user.name.first} ${user.name.last}`
  });

  // In staging, auto-verify so users aren't stuck without a working SMTP server
  if (process.env.NODE_ENV !== "production") {
    user.isVerified = true;
    await user.save();
  }

  return res.status(201).json({
    success: true,
    message: "OTP sent to email",
    data: { userId: user._id }
  });
};

const verifyOtp = async (req, res) => {
  const { userId, otp } = req.body;
  const user = await User.findById(userId).select("+otpHash +refreshTokenHash");
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  if (!user.otpHash || !user.otpExpiry || user.otpExpiry < new Date()) {
    return res.status(400).json({ success: false, message: "OTP expired or unavailable" });
  }

  const otpHash = hashSha256(otp);
  if (otpHash !== user.otpHash) {
    return res.status(400).json({ success: false, message: "Invalid OTP" });
  }

  user.isVerified = true;
  user.otpHash = undefined;
  user.otpExpiry = undefined;
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

const refresh = async (req, res) => {
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
  const user = await User.findById(userId).select("+otpHash");
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

  const otp = user.generateOTP(10);
  await user.save();
  await EmailService.sendOTPEmail({
    to: user.email,
    otp,
    name: `${user.name.first} ${user.name.last}`
  });

  return res.json({ success: true, message: "OTP resent to email" });
};

const forgotPassword = async (req, res) => {
  const { email } = req.body;
  const user = await User.findByEmail(email);
  if (!user) {
    return res.json({
      success: true,
      message: "If this email exists, a reset link has been sent"
    });
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashSha256(rawToken);
  await redis.set(`reset:${tokenHash}`, user._id.toString(), "EX", RESET_TOKEN_TTL_SECONDS);

  const resetLink = `${process.env.APP_BASE_URL || "http://localhost:3000"}/reset-password?token=${rawToken}`;
  await EmailService.sendPasswordResetEmail({ to: user.email, resetLink });

  return res.json({
    success: true,
    message: "If this email exists, a reset link has been sent"
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
  login,
  refresh,
  logout,
  resendOtp,
  forgotPassword,
  resetPassword
};
