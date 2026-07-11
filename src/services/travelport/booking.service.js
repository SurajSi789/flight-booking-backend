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
 */

const http = require("./http.client");
const { logger } = require("../../config/db");

const WORKBENCH_INIT_PATH  = "air/book/session/reservationworkbench";
const COMMIT_PATH_PREFIX   = "air/book/reservation/reservations";
const TRAVELER_PATH_PREFIX = "air/book/traveler/reservationworkbench";
const OFFER_GDS_SUFFIX     = "offers/buildfromproducts";
const OFFER_NDC_SUFFIX     = "offers/buildfromcatalogproductofferings";
const FOP_PATH_PREFIX      = "air/payment/reservationworkbench";
const PAYMENT_PATH_PREFIX  = "air/paymentoffer/reservationworkbench";

// ── Workbench init ────────────────────────────────────────────────────────────

async function initiateWorkbench() {
  // Body signals we want a new empty workbench (ReservationID type means "create new")
  const { data: raw, headers, status } = await http.postFull(WORKBENCH_INIT_PATH, { "@type": "ReservationID" });

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
  const raw = await http.post(path, body);

  const travelerId =
    raw?.Traveler?.Identifier?.value ||
    raw?.Traveler?.id ||
    raw?.id ||
    `trav_${index + 1}`;

  return travelerId;
}

// ── Offer add ─────────────────────────────────────────────────────────────────

function buildGdsOfferBody(pricedOffer) {
  return {
    "@type": "OfferQueryBuildFromProducts",
    BuildFromProductsRequest: {
      "@type": "BuildFromProductsRequestAir",
      CatalogProductOfferingsIdentifier: {
        Identifier: { authority: "Travelport", value: pricedOffer.catalogProductOfferingsIdentifier },
      },
      CatalogProductOfferingsSelection: {
        CatalogProductOfferingIdentifier: {
          Identifier: { authority: "Travelport", value: pricedOffer.catalogProductOfferingIdentifier },
        },
        ProductIdentifier: [
          { Identifier: { authority: "Travelport", value: pricedOffer.productIdentifier } },
        ],
      },
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

async function addOffer(workbenchId, pricedOffer, contentSource = "GDS") {
  const isNdc  = String(contentSource).toUpperCase() === "NDC";
  const suffix = isNdc ? OFFER_NDC_SUFFIX : OFFER_GDS_SUFFIX;
  const path   = `air/book/airoffer/reservationworkbench/${workbenchId}/${suffix}`;
  const body   = isNdc ? buildNdcOfferBody(pricedOffer) : buildGdsOfferBody(pricedOffer);
  const raw    = await http.post(path, body);

  const offerIdentifier =
    raw?.Offer?.Identifier?.value ||
    raw?.Offer?.id ||
    raw?.id;

  return { offerIdentifier, rawAddOfferResponse: raw };
}

// ── Form of payment (Cash / BSP agency billing) ────────────────────────────────

async function addFormOfPaymentCash(workbenchId, fopId = "formOfPayment_1") {
  const path = `${FOP_PATH_PREFIX}/${workbenchId}/formofpayment`;
  const body = {
    "@type": "FormOfPaymentCash",
    id: fopId,
  };
  const raw = await http.post(path, body);

  const fopIdentifier =
    raw?.FormOfPayment?.Identifier?.value ||
    raw?.Identifier?.value ||
    raw?.id ||
    fopId;

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
      Identifier: { authority: "Travelport", value: fopIdentifier },
    },
    OfferIdentifier: [
      {
        id: offerIdentifier,
        Identifier: { authority: "Travelport", value: offerIdentifier },
      },
    ],
  };
  return http.post(path, body);
}

// ── Commit ────────────────────────────────────────────────────────────────────

async function commitReservation(workbenchId) {
  const path = `${COMMIT_PATH_PREFIX}/${workbenchId}`;
  const raw  = await http.post(path, { "@type": "ReservationQueryCommitReservation" });

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

  if (!locator) {
    logger.error("[Travelport] commitReservation: no PNR locator in response", {
      reservationKeys: reservation && typeof reservation === "object" ? Object.keys(reservation) : typeof reservation,
      bodySnippet: JSON.stringify(raw || "").slice(0, 3000),
    });
    throw new Error("Travelport booking: no PNR locator in commit response");
  }

  // Extract offer ID and product ID from committed reservation for ticketing
  const offers = reservation?.Offer || reservation?.offer || [];
  const firstOffer = Array.isArray(offers) ? offers[0] : offers;
  const committedOfferId = firstOffer?.Identifier?.value || firstOffer?.id;
  const products = firstOffer?.Product || [];
  const committedProductId = (Array.isArray(products) ? products[0] : products)?.Identifier?.value;

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
  if (!passengers || !passengers.length) {
    throw new Error("Travelport booking: at least one passenger is required");
  }
  if (!pricedOffer?.catalogProductOfferingsIdentifier) {
    throw new Error("Travelport booking: pricedOffer must include catalogProductOfferingsIdentifier");
  }

  // Step 1: new workbench
  const workbenchId = await initiateWorkbench();

  // Step 2: add all travelers (sequentially — Travelport requires ordering)
  const travelerIds = [];
  for (let i = 0; i < passengers.length; i++) {
    const tId = await addTraveler(workbenchId, passengers[i], i, contact);
    travelerIds.push(tId);
  }

  // Step 3: add priced offer
  await addOffer(workbenchId, pricedOffer, contentSource);

  // Step 4: commit — creates the held PNR. Per the Travelport reference flow, Form-of-Payment,
  // Apply-Payment and Ticket issuance are a SEPARATE post-commit phase (re-open the workbench
  // from the locator). Doing FOP/payment pre-commit leaves the workbench in a non-committable
  // state ("COMMIT OR IGNORE RESERVATION WORKBENCH", 1G/4350).
  const result = await commitReservation(workbenchId);

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
