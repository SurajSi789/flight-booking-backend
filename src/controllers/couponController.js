const CouponService = require("../services/CouponService");

const validateCoupon = async (req, res) => {
  const { code, totalFare, provider, route } = req.body;
  const result = await CouponService.validate(
    code,
    Number(totalFare),
    provider,
    req.user.userId,
    route
  );

  return res.status(result.valid ? 200 : 400).json({
    success: result.valid,
    message: result.message,
    data: {
      valid: result.valid,
      discountAmount: result.discountAmount,
      finalFare: result.finalFare
    }
  });
};

module.exports = {
  validateCoupon
};
