const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/User");
const Offer = require("../models/Offer");
const { createRedisClient } = require("../config/redis");
const { env } = require("../config/env");
const { success } = require("../utils/apiResponse");

const redis = createRedisClient();

const clearRefreshCookie = (res) => {
  res.clearCookie("refreshToken", {
    httpOnly: true,
    sameSite: "strict",
    secure: env.nodeEnv === "production"
  });
};

const getProfile = async (req, res) => {
  const user = await User.findById(req.user.id).select("-passwordHash -refreshTokenHash");
  return res.json(success(user, "Profile fetched"));
};

const updateProfile = async (req, res) => {
  const user = await User.findById(req.user.id).select("-password");
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  const { name, phone } = req.body;
  if (name?.first != null) {
    user.name.first = String(name.first).trim();
  }
  if (name?.last != null) {
    user.name.last = String(name.last).trim();
  }
  if (phone !== undefined) {
    user.phone = String(phone).trim();
  }
  await user.save();
  return res.json(success(user, "Profile updated"));
};

const endOfUtcDay = (d) => {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate(), 23, 59, 59, 999));
};

const isInOfferWindow = (o, now) => {
  if (o.validFrom) {
    const from = new Date(o.validFrom);
    if (now < from) return false; // or use startOfUtcDay(from) if you only care about the day
  }
  if (o.validTo) {
    const to = new Date(o.validTo);
    if (now > endOfUtcDay(to)) return false; // inclusive end *date*
  }
  return true;
};

const getOffers = async (req, res) => {
  const now = new Date();
  const raw = await Offer.find({ isActive: true }).sort({ displayOrder: 1, createdAt: -1 }).lean();
  const offers = raw.filter((o) => isInOfferWindow(o, now));
  return res.json(success(offers, "Offers fetched"));
};

const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user.id).select("+passwordHash");
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  if (!(await user.comparePassword(currentPassword))) {
    return res.status(400).json({ success: false, message: "Current password is incorrect" });
  }

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.refreshTokenHash = null;
  await user.save();

  const authHeader = req.headers.authorization || "";
  const [, accessToken] = authHeader.split(/\s+/);
  if (accessToken) {
    try {
      const decoded = jwt.verify(accessToken, env.jwtAccessSecret);
      const ttlSeconds = Math.max(1, (decoded.exp || 0) - Math.floor(Date.now() / 1000));
      if (decoded.jti) {
        await redis.set(`blacklist:${decoded.jti}`, "1", "EX", ttlSeconds);
      }
    } catch {
      /* ignore invalid token */
    }
  }

  clearRefreshCookie(res);
  return res.json(success(null, "Password changed successfully"));
};

const listTravellers = async (req, res) => {
  const user = await User.findById(req.user.id).select("savedTravellers");
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  return res.json(success(user.savedTravellers || [], "Travellers fetched"));
};

const normalizeTravellerPayload = (body) => {
  let firstName = String(body.firstName || "").trim();
  let lastName = String(body.lastName || "").trim();
  if (!firstName && body.fullName) {
    const parts = String(body.fullName).trim().split(/\s+/);
    firstName = parts[0] || "";
    lastName = parts.slice(1).join(" ") || firstName;
  }
  const passportNo = String(body.passportNo || body.passportNumber || "").trim();
  const dobRaw = body.dob || body.dateOfBirth;
  const dob = dobRaw ? new Date(dobRaw) : undefined;
  return {
    firstName,
    lastName,
    gender: body.gender || undefined,
    passportNo,
    nationality: body.nationality ? String(body.nationality).trim() : undefined,
    dob: dob && !Number.isNaN(dob.getTime()) ? dob : undefined
  };
};

const addTraveller = async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  if ((user.savedTravellers?.length || 0) >= 10) {
    return res.status(400).json({ success: false, message: "Maximum 10 saved travellers" });
  }
  const t = normalizeTravellerPayload(req.body);
  if (!t.firstName || !t.lastName || !t.passportNo) {
    return res.status(400).json({ success: false, message: "firstName, lastName, and passport are required" });
  }
  user.savedTravellers.push({
    firstName: t.firstName,
    lastName: t.lastName,
    gender: t.gender,
    passportNo: t.passportNo,
    nationality: t.nationality,
    dob: t.dob
  });
  await user.save();
  const added = user.savedTravellers[user.savedTravellers.length - 1];
  return res.status(201).json(success(added, "Traveller added"));
};

const updateTraveller = async (req, res) => {
  const { travellerId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(travellerId)) {
    return res.status(400).json({ success: false, message: "Invalid traveller id" });
  }
  const user = await User.findById(req.user.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  const sub = user.savedTravellers.id(travellerId);
  if (!sub) {
    return res.status(404).json({ success: false, message: "Traveller not found" });
  }
  const body = req.body;
  if (body.fullName || body.firstName || body.lastName) {
    const t = normalizeTravellerPayload(body);
    if (t.firstName) sub.firstName = t.firstName;
    if (t.lastName) sub.lastName = t.lastName;
  }
  if (body.gender !== undefined) {
    sub.gender = body.gender || undefined;
  }
  const pass = body.passportNo || body.passportNumber;
  if (pass !== undefined) {
    sub.passportNo = String(pass).trim();
  }
  if (body.nationality !== undefined) {
    sub.nationality = body.nationality ? String(body.nationality).trim() : undefined;
  }
  const dobRaw = body.dob || body.dateOfBirth;
  if (dobRaw !== undefined) {
    const d = new Date(dobRaw);
    sub.dob = Number.isNaN(d.getTime()) ? undefined : d;
  }
  await user.save();
  return res.json(success(sub, "Traveller updated"));
};

const deleteTraveller = async (req, res) => {
  const { travellerId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(travellerId)) {
    return res.status(400).json({ success: false, message: "Invalid traveller id" });
  }
  const user = await User.findById(req.user.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  const sub = user.savedTravellers.id(travellerId);
  if (!sub) {
    return res.status(404).json({ success: false, message: "Traveller not found" });
  }
  sub.deleteOne();
  await user.save();
  return res.json(success(null, "Traveller removed"));
};

module.exports = {
  getProfile,
  updateProfile,
  getOffers,
  changePassword,
  listTravellers,
  addTraveller,
  updateTraveller,
  deleteTraveller
};
