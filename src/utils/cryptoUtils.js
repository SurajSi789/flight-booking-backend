const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { env } = require("../config/env");

const hashText = (text) => crypto.createHash("sha256").update(text).digest("hex");

const signAccessToken = (payload) =>
  jwt.sign(payload, env.jwtAccessSecret, {
    expiresIn: "15m"
  });

const signRefreshToken = (payload) => {
  const jti = uuidv4();
  const token = jwt.sign({ ...payload, jti }, env.jwtRefreshSecret, {
    expiresIn: "7d"
  });
  return { token, jti };
};

const verifyAccessToken = (token) => jwt.verify(token, env.jwtAccessSecret);
const verifyRefreshToken = (token) => jwt.verify(token, env.jwtRefreshSecret);

const secureCompare = (raw, expectedHash) => hashText(raw) === expectedHash;

module.exports = {
  hashText,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  secureCompare
};
