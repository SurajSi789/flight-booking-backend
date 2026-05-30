const express = require("express");
const { body, param } = require("express-validator");
const fareAlertController = require("../controllers/fareAlertController");
const asyncHandler = require("../utils/asyncHandler");
const validate = require("../middleware/validate");
const authenticate = require("../middleware/authenticate");

const router = express.Router();

router.use(authenticate);

router.get("/", asyncHandler(fareAlertController.listAlerts));

router.post(
  "/",
  validate([
    body("origin").matches(/^[A-Za-z]{3}$/),
    body("destination").matches(/^[A-Za-z]{3}$/),
    body("travelDate").isISO8601(),
    body("maxFare").isFloat({ gt: 0 }),
    body("adults").optional().isInt({ min: 1, max: 9 }),
    body("children").optional().isInt({ min: 0, max: 8 }),
    body("infants").optional().isInt({ min: 0, max: 4 })
  ]),
  asyncHandler(fareAlertController.createAlert)
);

router.patch(
  "/:id",
  validate([param("id").isMongoId(), body("isActive").optional().isBoolean()]),
  asyncHandler(fareAlertController.patchAlert)
);

router.delete("/:id", validate([param("id").isMongoId()]), asyncHandler(fareAlertController.deleteAlert));

module.exports = router;
