const axios = require("axios");
const { getToken, invalidateToken } = require("./auth.service");

const BASE_URL = (process.env.TRAVELPORT_BASE_URL || "https://api.pp.travelport.net").replace(/\/$/, "");
const API_VERSION = process.env.TRAVELPORT_API_VERSION || "11";
const ACCESS_GROUP = process.env.TRAVELPORT_ACCESS_GROUP || "";
const TIMEOUT_MS = Number(process.env.TRAVELPORT_TIMEOUT_MS || 30000);

function buildUrl(path) {
  return `${BASE_URL}/${API_VERSION}/${path}`;
}

async function buildHeaders(extra = {}) {
  const token = await getToken();
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "XAUTH_TRAVELPORT_ACCESSGROUP": ACCESS_GROUP,
    "Accept-Version": API_VERSION,
    "Content-Version": API_VERSION,
    ...extra,
  };
}

function extractErrorMessage(err) {
  const data = err.response?.data;
  return (
    data?.errors?.[0]?.message ||
    data?.error_description ||
    data?.message ||
    err.message ||
    "Travelport API request failed"
  );
}

async function request({ method, path, body, headers: extraHeaders = {}, retry = true }) {
  const headers = await buildHeaders(extraHeaders);
  const url = buildUrl(path);

  try {
    const response = await axios({ method, url, data: body, headers, timeout: TIMEOUT_MS });
    return response.data;
  } catch (err) {
    // Retry once on 401 — token may have expired between the cache check and the actual call
    if (err.response?.status === 401 && retry) {
      invalidateToken();
      return request({ method, path, body, headers: extraHeaders, retry: false });
    }

    const statusCode = err.response?.status || 500;
    const message = extractErrorMessage(err);
    const apiErr = new Error(`Travelport [${statusCode}] ${path}: ${message}`);
    apiErr.statusCode = statusCode;
    apiErr.responseData = err.response?.data;
    apiErr.travelportPath = path;
    throw apiErr;
  }
}

const get = (path, extra) => request({ method: "GET", path, headers: extra });
const post = (path, body, extra) => request({ method: "POST", path, body, headers: extra });
const put = (path, body, extra) => request({ method: "PUT", path, body, headers: extra });
const del = (path, body, extra) => request({ method: "DELETE", path, body, headers: extra });

module.exports = { get, post, put, del, buildUrl };
