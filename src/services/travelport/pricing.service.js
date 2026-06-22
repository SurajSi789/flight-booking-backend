/**
 * Travelport Trip Services V11 — Offer Pricing
 *
 * providerMeta fields required (set by search.service.js normalizer):
 *   transactionId  — search session ID used as CatalogProductOfferingsIdentifier
 *   offeringId     — CatalogProductOffering.id from search, e.g. "o1"
 *   productId      — Product.id from ReferenceListProduct, e.g. "p0"
 *   contentSource  — "GDS" | "NDC"
 *
 * GDS endpoint:  POST air/price/offers/buildfromproducts
 * NDC endpoint:  POST air/price/offers/buildfromcatalogproductofferings
 */

const http = require("./http.client");

const GDS_PRICE_PATH = "air/price/offers/buildfromproducts";
const NDC_PRICE_PATH = "air/price/offers/buildfromcatalogproductofferings";

// ── Request builders ──────────────────────────────────────────────────────────

function buildPassengerCriteria(passengers) {
  if (!passengers || passengers.length === 0) {
    return [{ "@type": "PassengerCriteria", number: 1, passengerTypeCode: "ADT" }];
  }
  const counts = { ADT: 0, CHD: 0, INF: 0 };
  for (const p of passengers) {
    const code = p.passengerTypeCode || p.type || "ADT";
    if (counts[code] !== undefined) counts[code]++;
  }
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([code, n]) => ({ "@type": "PassengerCriteria", number: n, passengerTypeCode: code }));
}

function buildGdsPriceBody({ transactionId, offeringId, productId, passengers }) {
  return {
    "@type": "OfferQueryBuildFromProducts",
    BuildFromProductsRequest: {
      "@type": "BuildFromProductsRequestAir",
      contentSourceList: ["GDS"],
      PassengerCriteria: buildPassengerCriteria(passengers),
      CatalogProductOfferingsIdentifier: {
        Identifier: { authority: "Travelport", value: transactionId },
      },
      CatalogProductOfferingsSelection: {
        CatalogProductOfferingIdentifier: {
          Identifier: { authority: "Travelport", value: offeringId },
        },
        ProductIdentifier: [
          { Identifier: { authority: "Travelport", value: productId } },
        ],
      },
    },
  };
}

function buildNdcPriceBody({ transactionId, offeringId, productId, passengers }) {
  return {
    "@type": "OfferQueryBuildFromCatalogProductOfferings",
    BuildFromCatalogProductOfferingsRequest: {
      "@type": "BuildFromCatalogProductOfferingsRequestAir",
      PassengerCriteria: buildPassengerCriteria(passengers),
      CatalogProductOfferingsIdentifier: {
        Identifier: { authority: "Travelport", value: transactionId },
      },
      CatalogProductOfferingSelection: [
        {
          CatalogProductOfferingIdentifier: {
            Identifier: { authority: "Travelport", value: offeringId },
          },
          ProductIdentifier: [
            { Identifier: { authority: "Travelport", value: productId } },
          ],
        },
      ],
    },
  };
}

// ── Response parser ──────────────────────────────────────────────────────────

function extractPricedOffer(raw) {
  // V11 price response is wrapped: { OfferListResponse: { ..., OfferList: { Offer: [...] } } }
  const responseWrapper = raw?.OfferListResponse;
  const result = responseWrapper?.Result;

  // Check for business-logic errors (HTTP 200 but GDS rejected the request)
  const errors = result?.Error || [];
  if (errors.length && !responseWrapper?.OfferList) {
    const msgs = errors.map((e) => `[${e.SourceCode}] ${e.Message}`).join("; ");
    throw new Error(`Travelport pricing rejected by GDS: ${msgs}`);
  }

  const offerListWrapper = responseWrapper?.OfferList || raw?.OfferList || raw?.offerList;
  const rawOffers = offerListWrapper?.Offer || offerListWrapper?.offer || raw?.Offer || [];
  const offer = Array.isArray(rawOffers) ? rawOffers[0] : rawOffers;

  if (!offer) {
    throw new Error("Travelport pricing: no offer returned in response");
  }

  const price = offer.Price || offer.price || {};

  // V11 can return price as flat fields (Base, TotalPrice) or nested (.value)
  const currency = price.CurrencyCode?.value || price.TotalPrice?.code || price.totalPrice?.code || "INR";
  const baseFare  = Number(price.Base       ?? price.BaseAmount?.value   ?? price.baseAmount?.value   ?? 0);
  const taxes     = Number(price.TotalTaxes ?? price.Taxes?.value        ?? price.taxes?.value        ?? 0);
  const fees      = Number(price.TotalFees  ?? price.Fees?.value         ?? 0);
  const totalFare = Number(price.TotalPrice ?? price.Total               ?? price.TotalPrice?.value   ?? baseFare + taxes + fees);

  const offerId         = offer.id || offer.Identifier?.value;
  const offerIdentifier = offer.Identifier?.value || offer.id;

  const product         = (offer.Product || offer.product || [])[0] || {};
  const productId       = product.id;
  const productIdentifier = product.Identifier?.value || product.id;

  return {
    offerId,
    offerIdentifier,
    productId,
    productIdentifier,
    pricedFare: {
      baseFare,
      taxes,
      fees,
      totalFare: totalFare || baseFare + taxes + fees,
      currency,
    },
    rawOffer: offer,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

// GDS error code 3459 = "PRODUCT CRITERIA IS REQUIRED"
// Occurs in sandbox where no real GDS session is maintained.
// In production, the search response includes CatalogProductOfferings.Identifier.value
// (a UUID) which is the session handle. In sandbox, only a transactionId is available
// and the GDS cannot find the session. When this happens, fall back to searchPrice.
const SANDBOX_PRODUCT_CRITERIA_ERROR = "3459";

async function priceOffer(providerMeta, contentSource, passengers) {
  // sessionId = production UUID from CatalogProductOfferings.Identifier.value
  //           = transactionId in sandbox (fallback, GDS may reject it)
  const sessionId     = providerMeta.sessionId  || providerMeta.transactionId || providerMeta.catalogProductOfferingsIdentifier;
  const offeringId    = providerMeta.offeringId || providerMeta.catalogProductOfferingIdentifier;
  const productId     = providerMeta.productId  || providerMeta.productIdentifier;
  const source        = contentSource || providerMeta.contentSource || "GDS";

  if (!sessionId || !offeringId || !productId) {
    throw new Error(
      `Travelport pricing: missing identifiers — sessionId=${sessionId} offeringId=${offeringId} productId=${productId}`
    );
  }

  const ids    = { transactionId: sessionId, offeringId, productId, passengers };
  const isNdc  = String(source).toUpperCase() === "NDC";
  const path   = isNdc ? NDC_PRICE_PATH : GDS_PRICE_PATH;
  const body   = isNdc ? buildNdcPriceBody(ids) : buildGdsPriceBody(ids);

  let raw;
  try {
    raw = await http.post(path, body);
  } catch (err) {
    // If the GDS rejects due to missing session (sandbox limitation), use search price
    if (providerMeta.searchPrice) {
      return buildFallbackOffer(providerMeta);
    }
    throw err;
  }

  // Check for GDS-level business errors even on HTTP 200
  const responseWrapper = raw?.OfferListResponse;
  const errors = responseWrapper?.Result?.Error || [];
  const sandboxError = errors.find((e) => e.SourceCode === SANDBOX_PRODUCT_CRITERIA_ERROR);
  if (sandboxError && !responseWrapper?.OfferList && providerMeta.searchPrice) {
    // Sandbox limitation — use the BestCombinablePrice from search as the price
    return buildFallbackOffer(providerMeta);
  }

  return extractPricedOffer(raw);
}

function buildFallbackOffer(providerMeta) {
  const sp = providerMeta.searchPrice || {};
  return {
    offerId:          providerMeta.offeringId,
    offerIdentifier:  providerMeta.offeringId,
    productId:        providerMeta.productId,
    productIdentifier: providerMeta.productId,
    isSandboxFallback: true,
    pricedFare: {
      baseFare:  Number(sp.baseFare  ?? 0),
      taxes:     Number(sp.taxes     ?? 0),
      fees:      0,
      totalFare: Number(sp.totalFare ?? 0),
      currency:  sp.currency || "INR",
    },
  };
}

module.exports = { priceOffer, buildGdsPriceBody, buildNdcPriceBody };
