const Notification = require("../models/Notification");
const { notificationQueue } = require("../jobs/notificationJob");

class NotificationService {
  async queueNotification({ userId, channel = "in_app", title, body, metadata = {} }) {
    const notification = await Notification.create({ 
      userId, 
      type: channel, 
      title, 
      body, 
      deliveryStatus: "pending" 
    });

    await notificationQueue.add("dispatch", {
      notificationId: notification._id.toString()
    });

    return notification;
  }
}

module.exports = new NotificationService();
