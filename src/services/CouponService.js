const mongoose = require("mongoose");
const Coupon = require("../models/Coupon");

class CouponService {
  async validate(code, fare, provider, userId, route) {
    if (!code) {
      return { valid: false, discountAmount: 0, finalFare: fare, message: "Coupon code is required" };
    }

    const normalizedCode = String(code).trim().toUpperCase();
    const coupon = await Coupon.findOne({ code: normalizedCode });
    if (!coupon) {
      return { valid: false, discountAmount: 0, finalFare: fare, message: "Coupon not found" };
    }

    const now = new Date();
    if (!coupon.isActive) {
      return { valid: false, discountAmount: 0, finalFare: fare, message: "Coupon is inactive" };
    }
    if (coupon.validFrom && coupon.validFrom > now) {
      return { valid: false, discountAmount: 0, finalFare: fare, message: "Coupon not active yet" };
    }
    if (coupon.validTo && coupon.validTo < now) {
      return { valid: false, discountAmount: 0, finalFare: fare, message: "Coupon expired" };
    }
    if (coupon.usedCount >= coupon.usageLimit) {
      return { valid: false, discountAmount: 0, finalFare: fare, message: "Coupon usage limit reached" };
    }
    if (fare < coupon.minFare) {
      return { valid: false, discountAmount: 0, finalFare: fare, message: "Minimum fare not met" };
    }

    if (Array.isArray(coupon.applicableProviders) && coupon.applicableProviders.length > 0) {
      if (!coupon.applicableProviders.includes(provider)) {
        return { valid: false, discountAmount: 0, finalFare: fare, message: "Coupon not valid for provider" };
      }
    }

    if (Array.isArray(coupon.applicableRoutes) && coupon.applicableRoutes.length > 0) {
      const origin = String(route?.origin || "").toUpperCase();
      const destination = String(route?.destination || "").toUpperCase();
      const routeMatch = coupon.applicableRoutes.some(
        (item) => item.origin === origin && item.destination === destination
      );
      if (!routeMatch) {
        return { valid: false, discountAmount: 0, finalFare: fare, message: "Coupon not valid for route" };
      }
    }

    const userUsageCount = coupon.usedBy.filter((entry) => entry.userId.toString() === String(userId)).length;
    if (userUsageCount >= coupon.perUserLimit) {
      return { valid: false, discountAmount: 0, finalFare: fare, message: "Per-user coupon limit reached" };
    }

    let discountAmount = 0;
    if (coupon.discountType === "percent") {
      discountAmount = (fare * coupon.discountValue) / 100;
      if (coupon.maxDiscount) {
        discountAmount = Math.min(discountAmount, coupon.maxDiscount);
      }
    } else {
      discountAmount = coupon.discountValue;
    }

    discountAmount = Math.max(0, Math.min(discountAmount, fare));
    return {
      valid: true,
      discountAmount,
      finalFare: fare - discountAmount,
      message: "Coupon applied",
      coupon
    };
  }

  async apply(bookingId, code, userId) {
    const normalizedCode = String(code).trim().toUpperCase();
    const now = new Date();
    const coupon = await Coupon.findOneAndUpdate(
      {
        code: normalizedCode,
        isActive: true,
        validFrom: { $lte: now },
        validTo: { $gte: now },
        $expr: { $lt: ["$usedCount", "$usageLimit"] }
      },
      {
        $inc: { usedCount: 1 },
        $push: { usedBy: { userId: new mongoose.Types.ObjectId(userId), usedAt: now } }
      },
      { new: true }
    );

    if (!coupon) {
      throw new Error("Failed to apply coupon. It may be exhausted or invalid.");
    }

    return coupon;
  }

  async unapply(bookingId, code, userId) {
    const normalizedCode = String(code).trim().toUpperCase();
    const coupon = await Coupon.findOneAndUpdate(
      { code: normalizedCode, usedCount: { $gt: 0 } },
      {
        $inc: { usedCount: -1 },
        $pull: { usedBy: { userId: new mongoose.Types.ObjectId(userId) } }
      },
      { new: true }
    );
    return coupon;
  }
}

module.exports = new CouponService();
