const FareAlert = require("../models/FareAlert");
const { success } = require("../utils/apiResponse");

const listAlerts = async (req, res) => {
  const rows = await FareAlert.find({ userId: req.user.userId }).sort({ createdAt: -1 }).lean();
  return res.json(success(rows, "Fare alerts"));
};

const createAlert = async (req, res) => {
  const { origin, destination, travelDate, maxFare, adults, children, infants } = req.body;
  const doc = await FareAlert.create({
    userId: req.user.userId,
    origin: String(origin).toUpperCase().trim(),
    destination: String(destination).toUpperCase().trim(),
    travelDate: new Date(travelDate),
    maxFare: Number(maxFare),
    adults: adults != null ? Number(adults) : 1,
    children: children != null ? Number(children) : 0,
    infants: infants != null ? Number(infants) : 0
  });
  return res.status(201).json(success(doc, "Fare alert created"));
};

const deleteAlert = async (req, res) => {
  const result = await FareAlert.deleteOne({ _id: req.params.id, userId: req.user.userId });
  if (result.deletedCount === 0) {
    return res.status(404).json({ success: false, message: "Alert not found" });
  }
  return res.json(success(null, "Fare alert removed"));
};

const patchAlert = async (req, res) => {
  const { isActive } = req.body;
  const alert = await FareAlert.findOne({ _id: req.params.id, userId: req.user.userId });
  if (!alert) {
    return res.status(404).json({ success: false, message: "Alert not found" });
  }
  if (typeof isActive === "boolean") {
    alert.isActive = isActive;
  }
  await alert.save();
  return res.json(success(alert, "Fare alert updated"));
};

module.exports = {
  listAlerts,
  createAlert,
  deleteAlert,
  patchAlert
};
