/**
 * Travelport Trip Services — Workbench Booking Flow
 *
 * Steps (all under a single workbench session):
 *   1. Initiate workbench  →  POST /air/book/session/reservationworkbench
 *   2. Add each traveler   →  POST /air/book/traveler/reservationworkbench/{id}/travelers
 *   3. Add priced offer    →  POST /air/book/airoffer/reservationworkbench/{id}/offers/buildfromcatalogproductofferings  (NDC)
 *                             POST /air/book/airoffer/reservationworkbench/{id}/offers/buildfromproducts                 (GDS)
 *   4. Add FOP Cash        →  POST /air/payment/reservationworkbench/{id}/formofpayment
 *   5. Apply payment       →  POST /air/paymentoffer/reservationworkbench/{id}/payments
 *   6. Commit reservation  →  POST /air/book/reservation/reservations/{id}
 *
 * Using FormOfPaymentCash for all bookings (agency BSP billing).
 * Razorpay handles the customer-facing payment on our side; Travelport sees only cash settlement.
 *
 * ── DEBUG INSTRUMENTATION ─────────────────────────────────────────────────────
 * This file adds comprehensive request/response logging, per-step Travelport
 * business-error validation (throwIfTravelportError), and richer catch-block
 * diagnostics so that failures like:
 *
 *   { "ReservationResponse": { "Result": { "Error": [{ "SourceCode": "4350",
 *       "Message": "COMMIT OR IGNORE RESERVATION WORKBENCH" }] } } }
 *
 * surface at the ACTUAL step that produced them (e.g. addTraveler / addOffer)
 * instead of only showing up later as an opaque "no PNR locator" error at
 * commit time. No endpoints, payloads, function signatures, exports, or the
 * booking step order have been changed.
 */

const http = require("./http.client");
const { logger } = require("../../config/db");
const { buildPassengerCriteria } = require("./pricing.service");

const WORKBENCH_INIT_PATH  = "air/book/session/reservationworkbench";
const COMMIT_PATH_PREFIX   = "air/book/reservation/reservations";
const TRAVELER_PATH_PREFIX = "air/book/traveler/reservationworkbench";
const OFFER_GDS_SUFFIX     = "offers/buildfromproducts";
const OFFER_NDC_SUFFIX     = "offers/buildfromcatalogproductofferings";
const FOP_PATH_PREFIX      = "air/payment/reservationworkbench";
const PAYMENT_PATH_PREFIX  = "air/paymentoffer/reservationworkbench";

// ── Debug helpers ──────────────────────────────────────────────────────────────

function safeJson(obj, max = 5000) {
  try {
    return JSON.stringify(obj, null, 2).slice(0, max);
  } catch (e) {
    return `[unserializable: ${e.message}]`;
  }
}

function now() {
  return Date.now();
}

function elapsedMs(startedAt) {
  return Date.now() - startedAt;
}

/**
 * Detects Travelport business-logic errors embedded in an otherwise HTTP-200
 * response body. Travelport nests `Result.Error` under a response-specific
 * wrapper — checked across ALL of them (OfferListResponse, ReservationResponse,
 * ReservationListResponse, TravelerResponse, CatalogProductOfferingsResponse,
 * plus a top-level Result) via http.getEmbeddedErrors. This is what catches
 * "1200 OFFER DATA IS INVALID" on Add Offer (under OfferListResponse.Result.Error)
 * so the booking stops there instead of blindly committing → "4350 COMMIT OR IGNORE".
 *
 * If found, logs the full response + every SourceCode/Message, then throws.
 * If not found, returns silently (no-op) so callers can proceed.
 */
function throwIfTravelportError(response, operation, context = {}) {
  const errorList = http.getEmbeddedErrors(response);

  if (!errorList) return;

  const errors = Array.isArray(errorList) ? errorList : [errorList];

  logger.error(`[Travelport] Business error detected during: ${operation}`, {
    operation,
    ...context,
    errorCount: errors.length,
    errors: errors.map((e) => ({ SourceCode: e?.SourceCode, Message: e?.Message })),
    fullResponse: safeJson(response, 8000),
  });

  errors.forEach((e) => {
    logger.error(`[Travelport] ${operation} — SourceCode ${e?.SourceCode}: ${e?.Message}`, {
      operation,
      SourceCode: e?.SourceCode,
      Message: e?.Message,
      ...context,
    });
  });

  const summary = errors
    .map((e) => `${e?.SourceCode || "UNKNOWN"} - ${e?.Message || "Unknown Travelport error"}`)
    .join("; ");

  throw new Error(`${operation}:\n\n${summary}`);
}

/**
 * Shared catch-block diagnostics. Logs operation, workbench id, request
 * payload, whatever response payload is available (including on the error
 * object itself, e.g. err.response?.data from an HTTP client), and the stack
 * trace — then rethrows the original error untouched.
 */
function logAndRethrow(operation, err, context = {}) {
  const responsePayload =
    err?.response?.data ??
    err?.raw ??
    context.responsePayload ??
    null;

  logger.error(`[Travelport] EXCEPTION during: ${operation}`, {
    operation,
    workbenchId: context.workbenchId,
    travelerId: context.travelerId,
    offerIdentifier: context.offerIdentifier,
    reservationIdentifier: context.reservationIdentifier,
    requestPayload: safeJson(context.requestPayload, 5000),
    responsePayload: safeJson(responsePayload, 5000),
    message: err?.message,
    stack: err?.stack,
  });

  throw err;
}

// ── Workbench init ────────────────────────────────────────────────────────────

async function initiateWorkbench() {
  const path = WORKBENCH_INIT_PATH;
  const body = { "@type": "ReservationID" };
  const startedAt = now();

  logger.info("[Travelport] Initiate Workbench Request", { path, body });

  let raw, headers, status;
  try {
    ({ data: raw, headers, status } = await http.postFull(path, body));
  } catch (err) {
    logAndRethrow("Initiate Workbench", err, { requestPayload: body });
  }

  logger.info("[Travelport] Initiate Workbench Response", {
    path,
    status,
    headers,
    response: raw,
    durationMs: elapsedMs(startedAt),
  });

  // Validate for embedded Travelport business errors before trying to extract an ID.
  throwIfTravelportError(raw, "Initiate Workbench", { requestPayload: body });

  let workbenchId =
    raw?.ReservationWorkbench?.Identifier?.value ||
    raw?.Reservation?.Identifier?.value ||
    raw?.ReservationResponse?.Reservation?.Identifier?.value ||
    raw?.Identifier?.value ||
    raw?.id;

  // Travelport frequently returns the workbench ID only in the Location / Content-Location
  // header, e.g. ".../reservationworkbench/{workbenchId}", with an empty body.
  if (!workbenchId) {
    const loc = headers?.location || headers?.["content-location"] || "";
    const m = String(loc).match(/reservationworkbench\/([^/?#]+)/i);
    if (m) workbenchId = m[1];
  }

  if (!workbenchId) {
    logger.error("[Travelport] initiateWorkbench: could not extract workbench ID", {
      status,
      location: headers?.location || headers?.["content-location"] || null,
      bodyType: raw && typeof raw === "object" ? Object.keys(raw) : typeof raw,
      bodySnippet: JSON.stringify(raw || "").slice(0, 2000),
    });
    throw new Error("Travelport booking: could not extract workbench ID from initiation response");
  }

  logger.info("[Travelport] Extracted Workbench ID", { workbenchId });

  return workbenchId;
}

// ── Traveler builders ─────────────────────────────────────────────────────────

const GENDER_MAP = { M: "Male", F: "Female", male: "Male", female: "Female" };
// Travelport GDS passenger type codes: Adult=ADT, Child=CNN, Infant=INF.
const PTC_MAP = { ADT: "ADT", CHD: "CNN", CNN: "CNN", CHILD: "CNN", INF: "INF" };
const PREFIX_MAP = { Male: "Mr", Female: "Ms" };

// Travelport dates must be plain YYYY-MM-DD — never a full ISO datetime.
function toTravelportDate(d) {
  if (!d) return undefined;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10); // "1999-01-01T00:00:00.000Z" → "1999-01-01"
}

// Body shape mirrors the official Travelport TripServices "Add Traveler" reference payload.
function buildTravelerBody(passenger, index, contact = {}) {
  const { firstName, lastName, dob, gender, type = "ADT", passportNo, nationality, passportExpiry } = passenger;
  const g = GENDER_MAP[gender] || GENDER_MAP[String(gender || "").toLowerCase()] || "Male";
  const ptc = PTC_MAP[String(type).toUpperCase()] || "ADT";
  const birthDate = toTravelportDate(dob);

  const body = {
    "@type": "Traveler",
    gender: g,
    passengerTypeCode: ptc,
    id: `trav_${index + 1}`,
    PersonName: {
      "@type": "PersonNameDetail",
      Prefix: PREFIX_MAP[g],
      Given: firstName,
      Surname: lastName,
    },
  };
  if (birthDate) body.birthDate = birthDate;

  // Contact — Travelport expects a phone (and usually email) on the traveler.
  const phone = passenger.phone || contact.phone;
  const email = passenger.email || contact.email;
  if (phone) {
    body.Telephone = [{
      "@type": "Telephone",
      countryAccessCode: String(contact.countryCode || "91"),
      phoneNumber: String(phone).replace(/\D/g, "").slice(-10),
      role: "Mobile",
      id: `phone_${index + 1}`,
    }];
  }
  if (email) {
    body.Email = [{ value: email }];
  }

  // International travel: attach passport as a TravelDocument.
  if (passportNo) {
    body.TravelDocument = [{
      "@type": "TravelDocumentDetail",
      docNumber: passportNo,
      docType: "Passport",
      expireDate: toTravelportDate(passportExpiry),
      issueCountry: nationality || undefined,
      birthDate,
      birthCountry: nationality || undefined,
      Gender: g,
      PersonName: { "@type": "PersonName", Given: firstName, Surname: lastName },
    }];
  }

  return body;
}

async function addTraveler(workbenchId, passenger, index, contact = {}) {
  const path = `${TRAVELER_PATH_PREFIX}/${workbenchId}/travelers`;
  const body = buildTravelerBody(passenger, index, contact);
  const startedAt = now();

  logger.info("[Travelport] Add Traveler Request", {
    workbenchId,
    index,
    path,
    body,
  });

  let raw;
  try {
    raw = await http.post(path, body);
  } catch (err) {
    logAndRethrow("Add Traveler", err, { workbenchId, requestPayload: body });
  }

  logger.info("[Travelport] Add Traveler Response", {
    workbenchId,
    index,
    response: raw,
    durationMs: elapsedMs(startedAt),
  });

  // Validate BEFORE trusting any extracted/fallback traveler ID. This is the
  // key guard against the workbench silently ending up in a bad state that
  // only surfaces later as a generic 4350 at commit time.
  throwIfTravelportError(raw, "Add Traveler", { workbenchId, requestPayload: body });

  const travelerId =
    raw?.Traveler?.Identifier?.value ||
    raw?.Traveler?.id ||
    raw?.id ||
    `trav_${index + 1}`;

  logger.info("[Travelport] Extracted Traveler ID", { workbenchId, index, travelerId });

  return travelerId;
}

// ── Offer add ─────────────────────────────────────────────────────────────────

// GDS Add Offer uses the self-contained BuildFromProducts / ProductCriteriaAir payload —
// identical BuildFromProductsRequest to the price call. The CatalogProductOfferings refs
// (o1/p0) are NOT valid here ("1200 OFFER DATA IS INVALID").
function buildGdsOfferBody(pricedOffer, passengers) {
  return {
    "@type": "OfferQueryBuildFromProducts",
    BuildFromProductsRequest: {
      "@type": "BuildFromProductsRequestAir",
      PassengerCriteria: buildPassengerCriteria(passengers),
      ProductCriteriaAir: pricedOffer.productCriteria,
    },
  };
}

function buildNdcOfferBody(pricedOffer) {
  return {
    "@type": "OfferQueryBuildFromCatalogProductOfferings",
    BuildFromCatalogProductOfferingsRequest: {
      "@type": "BuildFromCatalogProductOfferingsRequestAir",
      CatalogProductOfferingsIdentifier: {
        Identifier: { authority: "Travelport", value: pricedOffer.catalogProductOfferingsIdentifier },
      },
      CatalogProductOfferingSelection: [
        {
          CatalogProductOfferingIdentifier: {
            Identifier: { authority: "Travelport", value: pricedOffer.catalogProductOfferingIdentifier },
          },
          ProductIdentifier: [
            { Identifier: { authority: "Travelport", value: pricedOffer.productIdentifier } },
          ],
        },
      ],
    },
  };
}

async function addOffer(workbenchId, pricedOffer, contentSource = "GDS", passengers) {
  const isNdc  = String(contentSource).toUpperCase() === "NDC";
  const suffix = isNdc ? OFFER_NDC_SUFFIX : OFFER_GDS_SUFFIX;
  const path   = `air/book/airoffer/reservationworkbench/${workbenchId}/${suffix}`;
  const body   = isNdc ? buildNdcOfferBody(pricedOffer) : buildGdsOfferBody(pricedOffer, passengers);
  const startedAt = now();

  logger.info("[Travelport] Add Offer Request", {
    workbenchId,
    contentSource,
    path,
    body,
  });

  let raw;
  try {
    raw = await http.post(path, body);
  } catch (err) {
    logAndRethrow("Add Offer", err, { workbenchId, requestPayload: body });
  }

  logger.info("[Travelport] Add Offer Response", {
    workbenchId,
    response: raw,
    durationMs: elapsedMs(startedAt),
  });

  // Validate BEFORE trusting the extracted offer identifier. This is the
  // other prime suspect for a workbench getting stuck ("COMMIT OR IGNORE"),
  // since a rejected/partial offer add still leaves the workbench "dirty".
  throwIfTravelportError(raw, "Add Offer", { workbenchId, requestPayload: body });

  const offerIdentifier =
    raw?.Offer?.Identifier?.value ||
    raw?.Offer?.id ||
    raw?.id;

  logger.info("[Travelport] Extracted Offer Identifier", { workbenchId, offerIdentifier });

  return { offerIdentifier, rawAddOfferResponse: raw };
}

// ── Form of payment (Cash / BSP agency billing) ────────────────────────────────

async function addFormOfPaymentCash(workbenchId, fopId = "formOfPayment_1") {
  const path = `${FOP_PATH_PREFIX}/${workbenchId}/formofpayment`;
  const body = {
    "@type": "FormOfPaymentCash",
    id: fopId,
    FormOfPaymentRef: fopId,
  };
  const startedAt = now();

  logger.info("[Travelport] Add Form Of Payment (Cash) Request", { workbenchId, path, body });

  let raw;
  try {
    raw = await http.post(path, body);
  } catch (err) {
    logAndRethrow("Add Form Of Payment", err, { workbenchId, requestPayload: body });
  }

  logger.info("[Travelport] Add Form Of Payment (Cash) Response", {
    workbenchId,
    response: raw,
    durationMs: elapsedMs(startedAt),
  });

  throwIfTravelportError(raw, "Add Form Of Payment", { workbenchId, requestPayload: body });

  const fopIdentifier =
    raw?.FormOfPaymentResponse?.FormOfPayment?.Identifier?.value ||
    raw?.FormOfPayment?.Identifier?.value ||
    raw?.Identifier?.value ||
    raw?.id ||
    fopId;

  logger.info("[Travelport] Extracted FOP Identifier", { workbenchId, fopId, fopIdentifier });

  return { fopId, fopIdentifier };
}

// ── Apply payment ─────────────────────────────────────────────────────────────

async function applyPayment(workbenchId, { totalFare, currency, fopId, fopIdentifier, offerIdentifier }) {
  const path = `${PAYMENT_PATH_PREFIX}/${workbenchId}/payments`;
  const body = {
    "@type": "Payment",
    id: "payment_1",
    Amount: {
      code: currency || "USD",
      minorUnit: 2,
      currencySource: "Charged",
      value: totalFare,
    },
    FormOfPaymentIdentifier: {
      id: fopId,
      FormOfPaymentRef: fopId,
      Identifier: { authority: "Travelport", value: fopIdentifier },
    },
    OfferIdentifier: [
      {
        id: offerIdentifier,
        offerRef: offerIdentifier,
        Identifier: { authority: "Travelport", value: offerIdentifier },
      },
    ],
  };
  const startedAt = now();

  logger.info("[Travelport] Apply Payment Request", {
    workbenchId,
    offerIdentifier,
    fopId,
    fopIdentifier,
    path,
    body,
  });

  let raw;
  try {
    raw = await http.post(path, body);
  } catch (err) {
    logAndRethrow("Apply Payment", err, { workbenchId, offerIdentifier, requestPayload: body });
  }

  logger.info("[Travelport] Apply Payment Response", {
    workbenchId,
    offerIdentifier,
    response: raw,
    durationMs: elapsedMs(startedAt),
  });

  throwIfTravelportError(raw, "Apply Payment", { workbenchId, offerIdentifier, requestPayload: body });

  return raw;
}

// ── Commit ────────────────────────────────────────────────────────────────────

async function commitReservation(workbenchId) {
  const path = `${COMMIT_PATH_PREFIX}/${workbenchId}`;
  const body = { "@type": "ReservationQueryCommitReservation" };
  const startedAt = now();

  logger.info("[Travelport] Commit Reservation Request", { workbenchId, path, body });

  let raw;
  try {
    raw = await http.post(path, body);
  } catch (err) {
    logAndRethrow("Commit Reservation", err, { workbenchId, requestPayload: body });
  }

  logger.info("[Travelport] Commit Reservation Response", {
    workbenchId,
    response: raw,
    durationMs: elapsedMs(startedAt),
  });

  // Validate FIRST — this is where 4350 COMMIT OR IGNORE (and any other
  // Travelport business error) will now surface with its real SourceCode
  // and Message, instead of falling through to the generic "no PNR locator".
  throwIfTravelportError(raw, "Commit Reservation", { workbenchId, requestPayload: body });

  // Commit response shape (per Travelport reference):
  //   ReservationResponse.Reservation.Receipt[].Confirmation.Locator.value  ← the PNR
  const reservation =
    raw?.ReservationResponse?.Reservation ||
    raw?.Reservation ||
    raw;

  const receipts = Array.isArray(reservation?.Receipt)
    ? reservation.Receipt
    : (reservation?.Receipt ? [reservation.Receipt] : []);

  let locator = null;
  for (const rc of receipts) {
    const l = rc?.Confirmation?.Locator;
    const val = l && typeof l === "object" ? l.value : l;
    if (val) { locator = val; break; }
  }
  // Fallbacks for other response shapes
  if (!locator) {
    locator = reservation?.locator || reservation?.Locator?.value || null;
  }

  const resIdentifier =
    reservation?.Identifier?.value ||
    reservation?.ReservationIdentifier?.Identifier?.value ||
    workbenchId; // workbench id is the reservation handle for follow-up ops

  logger.info("[Travelport] Extracted Commit Identifiers", {
    workbenchId,
    reservationIdentifier: resIdentifier,
    locator,
  });

  if (!locator) {
    logger.error("[Travelport] commitReservation: no PNR locator in response", {
      workbenchId,
      reservationIdentifier: resIdentifier,
      reservationKeys: reservation && typeof reservation === "object" ? Object.keys(reservation) : typeof reservation,
      // Even though throwIfTravelportError above already handles Result.Error,
      // re-check and log here defensively in case Travelport returns a locator-less
      // "success" body with errors nested somewhere throwIfTravelportError doesn't cover.
      possibleErrors:
        raw?.Result?.Error || raw?.ReservationResponse?.Result?.Error || null,
      fullResponse: safeJson(raw, 8000),
    });
    throw new Error("Travelport booking: no PNR locator in commit response");
  }

  // Extract offer ID and product ID from committed reservation for ticketing
  const offers = reservation?.Offer || reservation?.offer || [];
  const firstOffer = Array.isArray(offers) ? offers[0] : offers;
  const committedOfferId = firstOffer?.Identifier?.value || firstOffer?.id;
  const products = firstOffer?.Product || [];
  const committedProductId = (Array.isArray(products) ? products[0] : products)?.Identifier?.value;

  logger.info("[Travelport] Extracted Committed Offer/Product", {
    workbenchId,
    committedOfferId,
    committedProductId,
  });

  return {
    pnr: locator,
    reservationIdentifier: resIdentifier,
    committedOfferId,
    committedProductId,
    rawReservation: reservation,
  };
}

// ── Orchestrated booking (steps 1-6) ─────────────────────────────────────────

async function createBooking({ passengers, pricedOffer, contentSource = "GDS", contact = {} }) {
  const bookingStartedAt = now();

  const isNdc = String(contentSource).toUpperCase() === "NDC";

  if (!passengers || !passengers.length) {
    throw new Error("Travelport booking: at least one passenger is required");
  }
  if (isNdc) {
    if (!pricedOffer?.catalogProductOfferingsIdentifier) {
      throw new Error("Travelport booking (NDC): pricedOffer must include catalogProductOfferingsIdentifier");
    }
  } else if (!Array.isArray(pricedOffer?.productCriteria) || pricedOffer.productCriteria.length === 0) {
    throw new Error("Travelport booking (GDS): pricedOffer.productCriteria is missing — re-run search/price");
  }

  logger.info("[Travelport] Booking Started", {
    passengerCount: passengers.length,
    contentSource,
    productCriteriaCount: pricedOffer.productCriteria?.length || 0,
  });

  // Step 1: new workbench
  let workbenchId;
  try {
    workbenchId = await initiateWorkbench();
  } catch (err) {
    logAndRethrow("createBooking → initiateWorkbench", err, {});
  }
  logger.info("[Travelport] Workbench Created", {
    workbenchId,
    durationMs: elapsedMs(bookingStartedAt),
  });

  // Step 2: add all travelers (sequentially — Travelport requires ordering)
  const travelerIds = [];
  for (let i = 0; i < passengers.length; i++) {
    const stepStartedAt = now();
    let tId;
    try {
      tId = await addTraveler(workbenchId, passengers[i], i, contact);
    } catch (err) {
      logAndRethrow("createBooking → addTraveler", err, {
        workbenchId,
        requestPayload: passengers[i],
      });
    }
    travelerIds.push(tId);
    logger.info("[Travelport] Traveler Added", {
      workbenchId,
      index: i,
      travelerId: tId,
      durationMs: elapsedMs(stepStartedAt),
    });
  }

  // Step 3: add priced offer
  const offerStepStartedAt = now();
  let offerResult;
  try {
    offerResult = await addOffer(workbenchId, pricedOffer, contentSource, passengers);
  } catch (err) {
    logAndRethrow("createBooking → addOffer", err, {
      workbenchId,
      requestPayload: pricedOffer,
    });
  }
  logger.info("[Travelport] Offer Added", {
    workbenchId,
    offerIdentifier: offerResult?.offerIdentifier,
    durationMs: elapsedMs(offerStepStartedAt),
  });

  // Step 4: commit — creates the held PNR. Per the Travelport reference flow, Form-of-Payment,
  // Apply-Payment and Ticket issuance are a SEPARATE post-commit phase (re-open the workbench
  // from the locator). Doing FOP/payment pre-commit leaves the workbench in a non-committable
  // state ("COMMIT OR IGNORE RESERVATION WORKBENCH", 1G/4350).
  logger.info("[Travelport] Commit Started", { workbenchId });
  const commitStepStartedAt = now();
  let result;
  try {
    result = await commitReservation(workbenchId);
  } catch (err) {
    logAndRethrow("createBooking → commitReservation", err, { workbenchId });
  }
  logger.info("[Travelport] Commit Completed", {
    workbenchId,
    pnr: result?.pnr,
    reservationIdentifier: result?.reservationIdentifier,
    durationMs: elapsedMs(commitStepStartedAt),
  });

  logger.info("[Travelport] Booking Completed", {
    workbenchId,
    pnr: result?.pnr,
    totalDurationMs: elapsedMs(bookingStartedAt),
  });

  return {
    workbenchId,
    travelerIds,
    ...result,
  };
}

module.exports = {
  createBooking,
  initiateWorkbench,
  addTraveler,
  addOffer,
  addFormOfPaymentCash,
  applyPayment,
  commitReservation,
};