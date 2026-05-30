const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "Forbidden: admin access required" });
  }
  return next();
};

module.exports = adminOnly;
