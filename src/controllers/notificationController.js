const Notification = require("../models/Notification");
const NotificationService = require("../services/NotificationService");
const { success } = require("../utils/apiResponse");

const listMyNotifications = async (req, res) => {
  const notifications = await Notification.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50);
  return res.json(success(notifications, "Notifications fetched"));
};

const sendNotification = async (req, res) => {
  const notification = await NotificationService.queueNotification({
    userId: req.body.userId,
    channel: req.body.channel,
    title: req.body.title,
    body: req.body.body,
    metadata: req.body.metadata
  });
  return res.status(201).json(success(notification, "Notification queued"));
};

module.exports = {
  listMyNotifications,
  sendNotification
};
