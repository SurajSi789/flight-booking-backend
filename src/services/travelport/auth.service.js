const axios = require("axios");

const AUTH_URL = process.env.TRAVELPORT_AUTH_URL || "https://auth.pp.travelport.net/oauth/token";
// Refresh 5 minutes before real expiry to avoid mid-request failures
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

let _cachedToken = null;
let _tokenExpiresAt = 0;

async function fetchNewToken() {
  const required = ["TRAVELPORT_USERNAME", "TRAVELPORT_PASSWORD", "TRAVELPORT_CLIENT_ID", "TRAVELPORT_CLIENT_SECRET"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Travelport auth: missing env vars: ${missing.join(", ")}`);
  }

  const params = new URLSearchParams({
    grant_type: "password",
    username: process.env.TRAVELPORT_USERNAME,
    password: process.env.TRAVELPORT_PASSWORD,
    client_id: process.env.TRAVELPORT_CLIENT_ID,
    client_secret: process.env.TRAVELPORT_CLIENT_SECRET,
  });

  const response = await axios.post(AUTH_URL, params.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    timeout: 15000,
  });

  const { access_token, expires_in } = response.data;
  if (!access_token) {
    throw new Error("Travelport auth: no access_token in response");
  }

  _cachedToken = access_token;
  // expires_in is seconds; subtract buffer so we refresh before it actually expires
  _tokenExpiresAt = Date.now() + Number(expires_in) * 1000 - REFRESH_BUFFER_MS;

  console.info(`[TravelportAuth] Token refreshed. Expires in ${expires_in}s (effective TTL: ${Math.round((expires_in - 300) / 60)}min)`);
  return _cachedToken;
}

async function getToken() {
  if (_cachedToken && Date.now() < _tokenExpiresAt) {
    return _cachedToken;
  }
  return fetchNewToken();
}

function invalidateToken() {
  _cachedToken = null;
  _tokenExpiresAt = 0;
}

module.exports = { getToken, invalidateToken };
