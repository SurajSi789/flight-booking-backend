const Queue = require("bull");
const { getQueueRedisConfig } = require("../config/redis");
const FareAlert = require("../models/FareAlert");
const Notification = require("../models/Notification");
const FlightSearchOrchestrator = require("../services/FlightSearchOrchestrator");
const { logger } = require("../config/db");

const fareAlertQueue = new Queue("fare-alert-queue", getQueueRedisConfig());

const TWELVE_H_MS = 12 * 60 * 60 * 1000;

fareAlertQueue.process("scan-alerts", async () => {
  const alerts = await FareAlert.find({ isActive: true }).limit(200).lean();
  const orchestrator = FlightSearchOrchestrator;

  for (const alert of alerts) {
    try {
      const travel = alert.travelDate ? new Date(alert.travelDate) : null;
      if (!travel || Number.isNaN(travel.getTime())) {
        continue;
      }
      const dateStr = travel.toISOString().slice(0, 10);
      const now = Date.now();
      if (travel.getTime() < now - 86400000) {
        continue;
      }

      const result = await orchestrator.search({
        origin: alert.origin,
        destination: alert.destination,
        date: dateStr,
        passengers: {
          adults: Number(alert.adults || 1),
          children: Number(alert.children || 0),
          infants: Number(alert.infants || 0)
        },
        cabin: "Y"
      });

      const flights = Array.isArray(result?.flights) ? result.flights : [];
      const fares = flights.map((f) => Number(f.totalFare || 0)).filter((n) => n > 0);
      const minFare = fares.length ? Math.min(...fares) : null;
      if (minFare == null || minFare > Number(alert.maxFare)) {
        continue;
      }

      const doc = await FareAlert.findById(alert._id);
      if (!doc) {
        continue;
      }

      if (doc.lastNotifiedAt && now - doc.lastNotifiedAt.getTime() < TWELVE_H_MS) {
        continue;
      }

      await Notification.create({
        userId: doc.userId,
        type: "in_app",
        title: "Fare dropped on your route",
        body: `${doc.origin} → ${doc.destination} on ${dateStr}: from ₹${Math.round(minFare)} (your cap ₹${Math.round(doc.maxFare)}).`,
        deliveryStatus: "sent",
        sentAt: new Date(),
        data: { fareAlertId: String(doc._id), minFare, route: `${doc.origin}-${doc.destination}` }
      });

      doc.lastNotifiedAt = new Date();
      doc.lastNotifiedFare = minFare;
      await doc.save();
    } catch (error) {
      logger.error("Fare alert scan failed", { alertId: alert._id?.toString?.(), error: error.message });
    }
  }
});

fareAlertQueue.on("failed", (job, error) => {
  logger.error("Fare alert job failed", { jobId: job.id, error: error.message });
});

fareAlertQueue.add(
  "scan-alerts",
  {},
  {
    jobId: "periodic-fare-alert-scan",
    repeat: { every: 30 * 60 * 1000 },
    removeOnComplete: true
  }
);

module.exports = {
  fareAlertQueue
};
