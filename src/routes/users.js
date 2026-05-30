const express = require("express");
const { body, param } = require("express-validator");
const userController = require("../controllers/userController");
const asyncHandler = require("../utils/asyncHandler");
const validate = require("../middleware/validate");
const authenticate = require("../middleware/authenticate");

const router = express.Router();

router.use(authenticate);

router.get("/profile", asyncHandler(userController.getProfile));
router.patch(
  "/profile",
  validate([
    body("name.first").optional().isString().trim().isLength({ min: 1, max: 64 }),
    body("name.last").optional().isString().trim().isLength({ min: 1, max: 64 }),
    body("phone").optional().isString().trim().isLength({ min: 6, max: 20 })
  ]),
  asyncHandler(userController.updateProfile)
);
router.get("/offers", asyncHandler(userController.getOffers));

router.post(
  "/change-password",
  validate([
    body("currentPassword").isString().notEmpty(),
    body("newPassword")
      .isString()
      .isLength({ min: 8 })
      .matches(/^(?=.*[A-Z])(?=.*\d).+$/)
      .withMessage("Password must contain at least one uppercase letter and one number")
  ]),
  asyncHandler(userController.changePassword)
);

router.get("/travellers", asyncHandler(userController.listTravellers));
router.post(
  "/travellers",
  validate([
    body("firstName").optional().isString().trim().isLength({ min: 1, max: 64 }),
    body("lastName").optional().isString().trim().isLength({ min: 1, max: 64 }),
    body("fullName").optional().isString().trim().isLength({ min: 2, max: 128 }),
    body("gender").optional().isIn(["M", "F"]),
    body("passportNo").optional().isString().trim().isLength({ min: 3, max: 32 }),
    body("passportNumber").optional().isString().trim().isLength({ min: 3, max: 32 }),
    body("nationality").optional().isString().trim(),
    body("dob").optional().isISO8601(),
    body("dateOfBirth").optional().isISO8601()
  ]),
  asyncHandler(userController.addTraveller)
);
router.put(
  "/travellers/:travellerId",
  validate([
    param("travellerId").isMongoId(),
    body("firstName").optional().isString().trim().isLength({ min: 1, max: 64 }),
    body("lastName").optional().isString().trim().isLength({ min: 1, max: 64 }),
    body("fullName").optional().isString().trim().isLength({ min: 2, max: 128 }),
    body("gender").optional().isIn(["M", "F"]),
    body("passportNo").optional().isString().trim().isLength({ min: 3, max: 32 }),
    body("passportNumber").optional().isString().trim().isLength({ min: 3, max: 32 }),
    body("nationality").optional().isString().trim(),
    body("dob").optional().isISO8601(),
    body("dateOfBirth").optional().isISO8601()
  ]),
  asyncHandler(userController.updateTraveller)
);
router.delete("/travellers/:travellerId", validate([param("travellerId").isMongoId()]), asyncHandler(userController.deleteTraveller));

module.exports = router;
