/**
 * Travelport Trip Services — Flight Exchange (Reshop + Reprice + Resell)
 *
 * Exchange flow:
 *   1. Reshop      →  POST /11/exchangesearch/catalogofferingsairchange
 *   2. Reprice     →  POST /11/air/price/offers/buildfromcatalogproductofferings  (using exchange result)
 *   3. Reopen wb   →  POST /11/air/book/session/reservationworkbench/buildfromlocator
 *   4. Add offer   →  POST /11/air/book/airoffer/reservationworkbench/{id}/offers/buildfromcatalogproductofferings
 *   5. Add FOP     →  POST /11/air/payment/reservationworkbench/{id}/formofpayment
 *   6. Pay penalty →  POST /11/air/paymentoffer/reservationworkbench/{id}/payments
 *   7. Commit      →  POST /11/air/book/reservation/reservations/{id}
 */

const http = require("./http.client");
const { reopenWorkbenchFromLocator } = require("./ticketing.service");
const { addOffer, addFormOfPaymentCash, applyPayment, commitReservation } = require("./booking.service");

const EXCHANGE_SEARCH_PATH = "exchangesearch/catalogofferingsairchange";
const NDC_PRICE_PATH       = "air/price/offers/buildfromcatalogproductofferings";

// ── Reshop ───────────────────────────────────────────────────────────────────

function buildExchangeSearchBody({ pnr, reservationIdentifier, offerId, productIds, searchLegs }) {
  return {
    "@type": "CatalogOfferingsQueryAirChange",
    CatalogOfferingsAirChangeRequest: {
      "@type": "CatalogOfferingsAirChangeRequestReservation",
      returnBrandedFaresInd: true,
      maxNumberOfUpsellsToReturn: 0,
      SearchCriteriaFlight: searchLegs.map((leg) => ({
        "@type": "SearchCriteriaFlight",
        departureDate: leg.departureDate,
        From: { value: leg.origin },
        To: { value: leg.destination },
      })),
      BuildFromReservationWorkbench: {
        ReservationIdentifier: {
          Identifier: { authority: "Travelport", value: reservationIdentifier || pnr },
        },
        OfferIdentifier: { id: offerId || "offer_1" },
        ProductIdentifier: (productIds || []).map((id) => ({ id })),
      },
    },
  };
}

async function searchExchangeOptions({ pnr, reservationIdentifier, offerId, productIds, searchLegs }) {
  if (!searchLegs || !searchLegs.length) {
    throw new Error("Travelport exchange: at least one search leg is required");
  }
  const body = buildExchangeSearchBody({ pnr, reservationIdentifier, offerId, productIds, searchLegs });
  const raw  = await http.post(EXCHANGE_SEARCH_PATH, body);

  const catalogOfferings = raw?.CatalogProductOfferings || raw?.CatalogOfferingsAirChange?.CatalogProductOfferings;
  const catalogOfferingsId = catalogOfferings?.Identifier?.value;

  const rawOfferings = catalogOfferings?.CatalogProductOffering || [];
  const options = (Array.isArray(rawOfferings) ? rawOfferings : []).map((o) => {
    const price = o.Price || {};
    return {
      catalogProductOfferingsIdentifier: catalogOfferingsId,
      catalogProductOfferingId: o.id,
      catalogProductOfferingIdentifier: o.Identifier?.value,
      productId: (o.Product || [])[0]?.id,
      productIdentifier: (o.Product || [])[0]?.Identifier?.value,
      totalFare: Number(price.TotalPrice?.value ?? 0),
      baseFare:  Number(price.BaseAmount?.value ?? 0),
      taxes:     Number(price.Taxes?.value ?? 0),
      currency:  price.TotalPrice?.code || "USD",
      changeFee: Number(price.ChangeFee?.value ?? 0),
    };
  });

  return { options, catalogProductOfferingsIdentifier: catalogOfferingsId, raw };
}

// ── Reprice (confirm the chosen exchange option) ──────────────────────────────

async function repriceExchangeOption(chosenOption) {
  const body = {
    "@type": "OfferQueryBuildFromCatalogProductOfferings",
    BuildFromCatalogProductOfferingsRequest: {
      "@type": "BuildFromCatalogProductOfferingsRequestAir",
      CatalogProductOfferingsIdentifier: {
        Identifier: { authority: "Travelport", value: chosenOption.catalogProductOfferingsIdentifier },
      },
      CatalogProductOfferingSelection: [
        {
          CatalogProductOfferingIdentifier: {
            Identifier: { authority: "Travelport", value: chosenOption.catalogProductOfferingIdentifier },
          },
          ProductIdentifier: [
            { Identifier: { authority: "Travelport", value: chosenOption.productIdentifier } },
          ],
        },
      ],
    },
  };

  const raw       = await http.post(NDC_PRICE_PATH, body);
  const offerList = raw?.OfferList || raw?.offerList;
  const offer     = (offerList?.Offer || offerList?.offer || [])[0] || {};
  const price     = offer.Price || {};

  return {
    offerId:           offer.id || offer.Identifier?.value,
    offerIdentifier:   offer.Identifier?.value || offer.id,
    productIdentifier: (offer.Product || [])[0]?.Identifier?.value,
    totalFare: Number(price.TotalPrice?.value ?? chosenOption.totalFare),
    currency:  price.TotalPrice?.code || chosenOption.currency || "USD",
  };
}

// ── Resell (commit the exchange) ──────────────────────────────────────────────

async function commitExchange({ pnr, reservationIdentifier, chosenOption, penaltyFare, currency = "USD" }) {
  // Step 3: reopen workbench
  const { workbenchId } = await reopenWorkbenchFromLocator(pnr, reservationIdentifier);

  // Step 4: add the exchange offer
  const { offerIdentifier } = await addOffer(workbenchId, {
    catalogProductOfferingsIdentifier: chosenOption.catalogProductOfferingsIdentifier,
    catalogProductOfferingIdentifier:  chosenOption.catalogProductOfferingIdentifier,
    productIdentifier:                 chosenOption.productIdentifier,
  }, "NDC");

  // Step 5-6: add FOP and apply the penalty/fare-difference payment
  const { fopId, fopIdentifier } = await addFormOfPaymentCash(workbenchId);
  await applyPayment(workbenchId, {
    totalFare: penaltyFare ?? chosenOption.totalFare,
    currency,
    fopId,
    fopIdentifier,
    offerIdentifier,
  });

  // Step 7: commit
  const result = await commitReservation(workbenchId);
  return { ...result, exchangeWorkbenchId: workbenchId };
}

// ── Orchestrated exchange (search + reprice + commit) ─────────────────────────

async function exchangeBooking({ pnr, reservationIdentifier, offerId, productIds, searchLegs, selectedOptionIndex = 0, penaltyFare, currency }) {
  const { options } = await searchExchangeOptions({ pnr, reservationIdentifier, offerId, productIds, searchLegs });

  if (!options.length) {
    throw new Error("Travelport exchange: no exchange options returned");
  }

  const chosen = options[selectedOptionIndex] || options[0];
  const repriced = await repriceExchangeOption(chosen);

  return commitExchange({
    pnr,
    reservationIdentifier,
    chosenOption: { ...chosen, ...repriced },
    penaltyFare,
    currency,
  });
}

module.exports = { searchExchangeOptions, repriceExchangeOption, commitExchange, exchangeBooking };
