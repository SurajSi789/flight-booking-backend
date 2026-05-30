const express = require("express");
const { query, body } = require("express-validator");
const flightController = require("../controllers/flightController");
const asyncHandler = require("../utils/asyncHandler");
const validate = require("../middleware/validate");
const buildRateLimiter = require("../middleware/rateLimiter");

const router = express.Router();

const isFutureDate = (value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return date.getTime() >= todayUtc; // allow today
};

const adultsLimitForSearch = (req) => {
  const group = String(req.query.searchProfile || "") === "group";
  return group ? 30 : 9;
};

router.get(
  "/fare-calendar",
  buildRateLimiter({ windowMs: 60 * 1000, max: 20 }),
  validate([
    query("origin").isString().matches(/^[A-Z]{3}$/),
    query("destination").isString().matches(/^[A-Z]{3}$/),
    query("month").matches(/^\d{4}-\d{2}$/)
  ]),
  asyncHandler(flightController.getFareCalendar)
);

router.get(
  "/search",
  buildRateLimiter({ windowMs: 30 * 1000, max: 60 }),
  validate([
    query("origin").isString().matches(/^[A-Z]{3}$/),
    query("destination").isString().matches(/^[A-Z]{3}$/),
    query("date")
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("date must be in YYYY-MM-DD format")
      .bail()
      .custom((value) => isFutureDate(value))
      .withMessage("date must be today or a future date"),
    query("searchProfile").optional().isIn(["leisure", "group"]),
    query("passengers.adults")
      .optional()
      .isInt({ min: 1 })
      .custom((value, { req }) => Number(value) <= adultsLimitForSearch(req)),
    query("adults")
      .optional()
      .isInt({ min: 1 })
      .custom((value, { req }) => Number(value) <= adultsLimitForSearch(req)),
    query("passengers.children").optional().isInt({ min: 0, max: 8 }),
    query("passengers.infants").optional().isInt({ min: 0, max: 4 }),
    query("passengers.children").optional().custom((children, { req }) => {
      const adults = Number(req.query["passengers.adults"] || req.query.adults || 1);
      return Number(children) <= adults;
    }),
    query("passengers.infants").optional().custom((infants, { req }) => {
      const adults = Number(req.query["passengers.adults"] || req.query.adults || 1);
      return Number(infants) <= adults;
    }),
    query("cabin").optional().isString()
  ]),
  asyncHandler(flightController.searchFlights)
);

router.get(
  "/verify",
  buildRateLimiter({ windowMs: 30 * 1000, max: 60 }),
  validate([
    query("provider").isIn(["indigo", "airindia", "spicejet", "akasa", "akasaair", "flightroutes24"]),
    query("routeData").isString().notEmpty(),
    query("flightData").optional().isString(),
    query("passengers.adults").optional().isInt({ min: 1, max: 9 }),
    query("passengers.children").optional().isInt({ min: 0, max: 8 }),
    query("passengers.infants").optional().isInt({ min: 0, max: 4 })
  ]),
  asyncHandler(flightController.verifyFlight)
);

router.get(
  "/fare-rules",
  buildRateLimiter({ windowMs: 30 * 1000, max: 60 }),
  validate([
    query("provider").isIn(["indigo", "airindia", "spicejet", "akasa", "akasaair", "flightroutes24"]),
    query("data").optional().isString(),
    query("fareAvailabilityKey").optional().isString(),
    query("origin").optional().matches(/^[A-Z]{3}$/),
    query("destination").optional().matches(/^[A-Z]{3}$/),
    query("date").optional().matches(/^\d{4}-\d{2}-\d{2}$/)
  ]),
  asyncHandler(flightController.getFareRules)
);

router.post(
  "/seat-map",
  buildRateLimiter({ windowMs: 30 * 1000, max: 30 }),
  validate([
    body("airSegment").isObject().withMessage("airSegment must be an object"),
    body("hostToken").isString().notEmpty().withMessage("hostToken is required"),
    body("provider")
      .optional()
      .isIn(["indigo", "airindia", "spicejet", "akasa", "akasaair", "flightroutes24"]),
    body("travelers").optional().isArray(),
  ]),
  asyncHandler(flightController.getSeatMap)
);

module.exports = router;
