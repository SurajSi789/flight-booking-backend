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
  const raw = await http.post(WORKBENCH_INIT_PATH, { "@type": "ReservationID" });

  const workbenchId =
    raw?.ReservationWorkbench?.Identifier?.value ||
    raw?.Identifier?.value ||
    raw?.id;

  if (!workbenchId) {
    throw new Error("Travelport booking: could not extract workbench ID from initiation response");
  }
  return workbenchId;
}

// ── Traveler builders ─────────────────────────────────────────────────────────

const GENDER_MAP = { M: "Male", F: "Female", male: "Male", female: "Female" };
const PAX_TYPE_MAP = { ADT: "Adult", CHD: "Child", INF: "InfantInLap" };

function buildTravelerBody(passenger, index) {
  const { firstName, lastName, dob, gender, type = "ADT", passportNo, nationality, passportExpiry } = passenger;
  const travelerId = `traveler_${index + 1}`;

  const travelerBody = {
    "@type": "TravelerCriteria",
    Traveler: {
      "@type": "Traveler",
      id: travelerId,
      passengerTypeCode: type,
      age: dob ? calculateAge(dob) : undefined,
      PersonName: {
        "@type": "PersonName",
        Given: firstName,
        Surname: lastName,
        nameType: PAX_TYPE_MAP[type] || "Adult",
      },
      Gender: GENDER_MAP[gender] || GENDER_MAP[String(gender || "").toLowerCase()] || "Male",
    },
  };

  // International travel: attach passport if present
  if (passportNo) {
    travelerBody.Traveler.IdentityDocument = {
      "@type": "IdentityDocumentPassport",
      documentNumber: passportNo,
      docType: "Passport",
      expireDate: passportExpiry || undefined,
      residenceCountryCode: nationality || undefined,
      issuanceCountryCode: nationality || undefined,
    };
  }

  if (dob) {
    travelerBody.Traveler.birthDate = dob;
  }

  return travelerBody;
}

function calculateAge(dob) {
  const birth = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

async function addTraveler(workbenchId, passenger, index) {
  const path = `${TRAVELER_PATH_PREFIX}/${workbenchId}/travelers`;
  const body = buildTravelerBody(passenger, index);
  const raw = await http.post(path, body);

  const travelerId =
    raw?.Traveler?.Identifier?.value ||
    raw?.Traveler?.id ||
    raw?.id ||
    `traveler_${index + 1}`;

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

  // After commit, the response contains the Reservation with a locator (PNR)
  const reservation = raw?.Reservation || raw;
  const locator     = reservation?.locator || reservation?.Locator?.value;
  const resIdentifier =
    reservation?.Identifier?.value ||
    reservation?.ReservationIdentifier?.Identifier?.value;

  if (!locator) {
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

async function createBooking({ passengers, pricedOffer, contentSource = "GDS" }) {
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
    const tId = await addTraveler(workbenchId, passengers[i], i);
    travelerIds.push(tId);
  }

  // Step 3: add priced offer
  const { offerIdentifier } = await addOffer(workbenchId, pricedOffer, contentSource);

  // Step 4: add FormOfPaymentCash (agency BSP billing)
  const { fopId, fopIdentifier } = await addFormOfPaymentCash(workbenchId);

  // Step 5: apply payment against the offer
  await applyPayment(workbenchId, {
    totalFare: pricedOffer.totalFare,
    currency: pricedOffer.currency || "USD",
    fopId,
    fopIdentifier,
    offerIdentifier,
  });

  // Step 6: commit — produces PNR + tickets in a single call (instant-pay flow)
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
