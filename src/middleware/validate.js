const { validationResult } = require("express-validator");

const validate = (validations) => [
  ...validations,
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        data: errors.array()
      });
    }
    return next();
  }
];

module.exports = validate;
