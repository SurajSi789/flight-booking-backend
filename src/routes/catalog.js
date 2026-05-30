const express = require("express");
const userController = require("../controllers/userController");
const airportController = require("../controllers/airportController");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

router.get("/offers", asyncHandler(userController.getOffers));
router.get("/airports", asyncHandler(airportController.searchAirports));
router.get("/nearby-airports/:code", asyncHandler(airportController.getNearby));

module.exports = router;
