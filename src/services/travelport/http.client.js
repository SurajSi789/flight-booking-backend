const axios = require("axios");
const { getToken, invalidateToken } = require("./auth.service");
const { logger } = require("../../config/db");

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

// Travelport returns business/validation errors as HTTP 200 with a Result.Error array
// nested under a response-specific wrapper. Collect it across every known wrapper.
function getEmbeddedErrors(data) {
  if (!data || typeof data !== "object") return null;
  const candidates = [
    data.Result?.Error,
    data.OfferListResponse?.Result?.Error,
    data.ReservationResponse?.Result?.Error,
    data.ReservationListResponse?.Result?.Error,
    data.TravelerResponse?.Result?.Error,
    data.CatalogProductOfferingsResponse?.Result?.Error,
    data.errors,
    data.Errors,
  ];
  for (const errs of candidates) {
    if (Array.isArray(errs) && errs.length) return errs;
  }
  return null;
}

function formatErrors(errs) {
  return errs
    .map((e) => `[${e.SourceCode || e.category || e.StatusCode || "ERR"}] ${e.Message || e.message || "error"}`)
    .join("; ");
}

// Throw if a (HTTP-200) response body carries an embedded Travelport error. Callers use
// this so a business failure (e.g. "OFFER DATA IS INVALID") stops the flow immediately
// instead of silently proceeding to a later step that fails more cryptically.
function assertNoEmbeddedError(data, step) {
  const errs = getEmbeddedErrors(data);
  if (errs) {
    logger.error(`[Travelport] ${step} returned an embedded error`, {
      errors: errs,
      bodySnippet: JSON.stringify(data || "").slice(0, 3000),
    });
    const err = new Error(`Travelport ${step}: ${formatErrors(errs)}`);
    err.travelportEmbeddedError = errs;
    throw err;
  }
  return data;
}

function extractErrorMessage(err) {
  const data = err.response?.data;
  const embedded = getEmbeddedErrors(data);
  if (embedded) return formatErrors(embedded);
  return (
    data?.error_description ||
    data?.error?.message ||
    data?.message ||
    err.message ||
    "Travelport API request failed"
  );
}

async function request({ method, path, body, headers: extraHeaders = {}, retry = true, fullResponse = false }) {
  const headers = await buildHeaders(extraHeaders);
  const url = buildUrl(path);

  try {
    const response = await axios({ method, url, data: body, headers, timeout: TIMEOUT_MS });
    // Some Travelport endpoints (e.g. workbench init) return their identifier only in the
    // Location/Content-Location header with an empty body — callers that need it pass fullResponse.
    return fullResponse
      ? { data: response.data, headers: response.headers || {}, status: response.status }
      : response.data;
  } catch (err) {
    // Retry once on 401 — token may have expired between the cache check and the actual call
    if (err.response?.status === 401 && retry) {
      invalidateToken();
      return request({ method, path, body, headers: extraHeaders, retry: false, fullResponse });
    }

    const statusCode = err.response?.status || 500;
    const message = extractErrorMessage(err);
    // Log Travelport's full error payload — the generic status message hides the actual
    // field-level validation reason (e.g. which traveler field the 400 objected to).
    logger.error(`[Travelport HTTP] ${statusCode} ${path}`, {
      message,
      requestBody: (() => { try { return JSON.stringify(body).slice(0, 2000); } catch { return undefined; } })(),
      responseData: (() => { try { return JSON.stringify(err.response?.data).slice(0, 4000); } catch { return String(err.response?.data || "").slice(0, 4000); } })(),
    });
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
// Full-response variant: returns { data, headers, status } — for endpoints whose identifier
// is only in a response header (e.g. Location on workbench init).
const postFull = (path, body, extra) => request({ method: "POST", path, body, headers: extra, fullResponse: true });

module.exports = { get, post, put, del, postFull, buildUrl, assertNoEmbeddedError, getEmbeddedErrors };
