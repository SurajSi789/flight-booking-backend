const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// Only these are truly required to boot
const coreRequired = ["MONGO_URI", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "REDIS_URL"];

const missing = coreRequired.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

const optional = [
  "INDIGO_TARGET_BRANCH","INDIGO_USERNAME","INDIGO_PASSWORD",
  "AIX_USERNAME","AIX_PASSWORD",
  "AKASA_TEST_URL","AKASA_TEST_USERNAME","AKASA_TEST_PASSWORD","AKASA_TEST_DOMAIN",
  "SG_SOAP_URL","SG_USERNAME","SG_PASSWORD",
  "FR24_CID",
  "RAZORPAY_KEY_ID","RAZORPAY_KEY_SECRET","RAZORPAY_WEBHOOK_SECRET",
  "SMTP_HOST","SMTP_USER","SMTP_PASS",
  "OPENAI_API_KEY",
];
const missingOptional = optional.filter((k) => !process.env[k]);
if (missingOptional.length && process.env.NODE_ENV !== "production") {
  console.warn(`[env] Mock mode active for: ${missingOptional.join(", ")}`);
}

const parseCsv = (v = "") => v.split(",").map((s) => s.trim()).filter(Boolean);

// Payment mock mode: true when no real Razorpay key is provided
const isPaymentMock =
  !process.env.RAZORPAY_KEY_ID ||
  process.env.RAZORPAY_KEY_ID === "rzp_test_mock" ||
  process.env.PAYMENT_MOCK === "true";

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGO_URI,
  redisUrl: process.env.REDIS_URL,
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  corsWhitelist: parseCsv(process.env.CORS_WHITELIST),
  isPaymentMock,
  smtp: {
    host: process.env.SMTP_HOST || null,
    user: process.env.SMTP_USER || null,
    pass: process.env.SMTP_PASS || null,
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@skybook.test",
  },
  providers: {
    indigo:       { targetBranch: process.env.INDIGO_TARGET_BRANCH || null, username: process.env.INDIGO_USERNAME || null, password: process.env.INDIGO_PASSWORD || null },
    aix:          { username: process.env.AIX_USERNAME || null, password: process.env.AIX_PASSWORD || null },
    spiceJet:     { soapUrl: process.env.SG_SOAP_URL || null, username: process.env.SG_USERNAME || null, password: process.env.SG_PASSWORD || null },
    flightRoutes24: { cid: process.env.FR24_CID || null },
    akasaair:     { soapurl: process.env.AKASA_TEST_URL || null, username: process.env.AKASA_TEST_USERNAME || null, password: process.env.AKASA_TEST_PASSWORD || null, domain: process.env.AKASA_TEST_DOMAIN || null },
  },
  razorpay: {
    keyId:         process.env.RAZORPAY_KEY_ID     || "rzp_test_mock",
    keySecret:     process.env.RAZORPAY_KEY_SECRET  || "mock_razorpay_secret_skybook",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "mock_webhook_secret_skybook",
  },
  openAiApiKey: process.env.OPENAI_API_KEY || null,
};

module.exports = { env, requiredEnvVars: coreRequired };
