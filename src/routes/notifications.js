const express = require("express");
const { body } = require("express-validator");
const notificationController = require("../controllers/notificationController");
const asyncHandler = require("../utils/asyncHandler");
const authenticate = require("../middleware/authenticate");
const adminOnly = require("../middleware/adminOnly");
const validate = require("../middleware/validate");

const router = express.Router();

router.get("/", authenticate, asyncHandler(notificationController.listMyNotifications));

router.post(
  "/",
  authenticate,
  adminOnly,
  validate([
    body("userId").isMongoId(),
    body("channel").isIn(["email", "sms", "push", "in_app"]),
    body("title").isString().notEmpty(),
    body("body").isString().notEmpty()
  ]),
  asyncHandler(notificationController.sendNotification)
);

module.exports = router;
