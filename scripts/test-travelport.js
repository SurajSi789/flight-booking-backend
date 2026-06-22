/**
 * Travelport Trip Services — connection & parser diagnostic
 * Run from the backend root:  node scripts/test-travelport.js
 *
 * Steps:
 *  0  Validate env vars
 *  1  OAuth2 token (grant_type=password)
 *  2  Search DEL→DXB (7 days out)
 *  3  Parse results using search.service.js normalizer
 *  4  Price the first GDS offering
 */

require("dotenv").config();
const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const AUTH_URL   = process.env.TRAVELPORT_AUTH_URL  || "https://auth.pp.travelport.net/oauth/token";
const BASE_URL   = (process.env.TRAVELPORT_BASE_URL || "https://api.pp.travelport.net").replace(/\/$/, "");
const VERSION    = process.env.TRAVELPORT_API_VERSION || "11";
const GROUP      = process.env.TRAVELPORT_ACCESS_GROUP || "";
const CLIENT_ID  = process.env.TRAVELPORT_CLIENT_ID || "";
const CLIENT_SEC = process.env.TRAVELPORT_CLIENT_SECRET || "";
const USERNAME   = process.env.TRAVELPORT_USERNAME || "";
const PASSWORD   = process.env.TRAVELPORT_PASSWORD || "";

function sep(label) {
  console.log("\n" + "─".repeat(60));
  console.log("  " + label);
  console.log("─".repeat(60));
}

function getTomorrow(daysAhead = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

function printEnv() {
  sep("0. Environment check");
  const vars = {
    CLIENT_ID,
    CLIENT_SEC: CLIENT_SEC ? `${CLIENT_SEC.slice(0, 6)}…` : "(empty)",
    USERNAME,
    PASSWORD: PASSWORD ? `${PASSWORD.slice(0, 4)}…` : "(empty)",
    GROUP,
    AUTH_URL,
    BASE_URL,
  };
  for (const [k, v] of Object.entries(vars)) {
    const ok = v && v !== "(empty)";
    console.log(`  ${ok ? "✅" : "❌"} ${k.padEnd(15)} = ${v}`);
  }
  const missing = [CLIENT_ID, CLIENT_SEC, USERNAME, PASSWORD, GROUP].filter((v) => !v);
  if (missing.length) {
    console.log("\n  ❌ Missing credentials — fill in .env and re-run.");
    process.exit(1);
  }
}

async function testAuth() {
  sep("1. OAuth2 token  →  POST " + AUTH_URL);
  const params = new URLSearchParams({
    grant_type:    "password",
    username:      USERNAME,
    password:      PASSWORD,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SEC,
  });
  console.log("  Sending grant_type=password …");
  try {
    const res = await axios.post(AUTH_URL, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });
    const { access_token, expires_in, token_type } = res.data;
    console.log(`  ✅ Token received  type=${token_type}  expires_in=${expires_in}s`);
    console.log(`     ${access_token.slice(0, 40)}…`);
    return access_token;
  } catch (err) {
    console.log("  ❌ Auth FAILED");
    console.log("     Status :", err.response?.status);
    console.log("     Body   :", JSON.stringify(err.response?.data, null, 2));
    process.exit(1);
  }
}

function makeHeaders(token) {
  return {
    Authorization:                `Bearer ${token}`,
    "Content-Type":               "application/json",
    Accept:                       "application/json",
    XAUTH_TRAVELPORT_ACCESSGROUP: GROUP,
    "Accept-Version":             VERSION,
    "Content-Version":            VERSION,
  };
}

async function testSearch(token) {
  const date = getTomorrow(7);
  const url  = `${BASE_URL}/${VERSION}/air/catalog/search/catalogproductofferings`;

  const body = {
    "@type": "CatalogProductOfferingsQueryRequest",
    CatalogProductOfferingsRequest: {
      "@type":             "CatalogProductOfferingsRequestAir",
      contentSourceList:   ["GDS"],
      PassengerCriteria:   [{ "@type": "PassengerCriteria", number: 1, passengerTypeCode: "ADT" }],
      SearchCriteriaFlight: [
        { "@type": "SearchCriteriaFlight", departureDate: date, From: { value: "DEL" }, To: { value: "DXB" } },
      ],
    },
  };

  sep(`2. Search DEL→DXB (${date})  →  POST …/catalogproductofferings`);
  console.log("  Sending search request …");
  try {
    const res = await axios.post(url, body, { headers: makeHeaders(token), timeout: 30000 });
    console.log(`  ✅ HTTP ${res.status}`);

    const outPath = path.join(__dirname, "travelport-search-response.json");
    fs.writeFileSync(outPath, JSON.stringify(res.data, null, 2));
    console.log(`  Full response saved → ${outPath}`);
    return res.data;
  } catch (err) {
    console.log("  ❌ Search FAILED");
    console.log("     Status :", err.response?.status);
    console.log("     Body   :", JSON.stringify(err.response?.data, null, 2));
    return null;
  }
}

function testParser(raw) {
  sep("3. Parser — search.service.js normalizer");

  // Inline the same logic as search.service.js so we can test without the full server
  function parseDurationMins(iso) {
    if (!iso) return 0;
    const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
    return m ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : 0;
  }

  function toDateTime(date, time) {
    if (!date) return null;
    return new Date(`${date}T${time || "00:00:00"}`);
  }

  const resp            = raw.CatalogProductOfferingsResponse;
  const transactionId   = resp?.transactionId;
  const rawOfferings    = resp?.CatalogProductOfferings?.CatalogProductOffering || [];
  const referenceList   = resp?.ReferenceList || [];

  console.log(`  transactionId     = ${transactionId}`);
  console.log(`  raw offerings     = ${rawOfferings.length}`);
  console.log(`  reference lists   = ${referenceList.length} (${referenceList.map((r) => r["@type"]).join(", ")})`);

  // Build indexes
  const flightIndex = {};
  const productIndex = {};
  for (const rl of referenceList) {
    if (rl["@type"] === "ReferenceListFlight")   (rl.Flight   || []).forEach((f) => { flightIndex[f.id]  = f; });
    if (rl["@type"] === "ReferenceListProduct")  (rl.Product  || []).forEach((p) => { productIndex[p.id] = p; });
  }
  console.log(`  flight refs       = ${Object.keys(flightIndex).join(", ")}`);
  console.log(`  product refs      = ${Object.keys(productIndex).join(", ")}`);

  const flights = [];
  for (const offering of rawOfferings) {
    for (const pbo of (offering.ProductBrandOptions || [])) {
      for (const bo of (pbo.ProductBrandOffering || [])) {
        const productRef = (bo.Product || [])[0]?.productRef;
        const product    = productIndex[productRef];
        if (!product) continue;

        const segs = (product.FlightSegment || []).map((seg) => {
          const f = flightIndex[seg.Flight?.FlightRef];
          return f ? `${f.carrier}${f.number} ${f.Departure?.location}→${f.Arrival?.location} dep=${f.Departure?.date} ${f.Departure?.time}` : null;
        }).filter(Boolean);

        const price = bo.BestCombinablePrice || {};
        const total = price.TotalPrice ?? 0;

        flights.push({ id: `${offering.id}-${productRef}`, segments: segs, total, currency: price.CurrencyCode?.value });
      }
    }
  }

  console.log(`\n  Parsed ${flights.length} normalized flights:\n`);
  for (const f of flights) {
    console.log(`  [${f.id}]  INR ${f.total}  |  ${f.segments.join("  »  ")}`);
  }

  return { flights, transactionId, rawOfferings };
}

async function testPrice(token, parsedData) {
  if (!parsedData) return;
  const { transactionId, rawOfferings } = parsedData;
  const firstOffering = rawOfferings?.[0];
  if (!firstOffering) return;

  const firstBO = firstOffering.ProductBrandOptions?.[0]?.ProductBrandOffering?.[0];
  if (!firstBO) return;

  const offeringId = firstOffering.id;
  const productId  = (firstBO.Product || [])[0]?.productRef;

  sep("4. Price first GDS offering");
  console.log(`  transactionId = ${transactionId}`);
  console.log(`  offeringId    = ${offeringId}`);
  console.log(`  productId     = ${productId}`);

  const url  = `${BASE_URL}/${VERSION}/air/price/offers/buildfromproducts`;
  const body = {
    "@type": "OfferQueryBuildFromProducts",
    BuildFromProductsRequest: {
      "@type": "BuildFromProductsRequestAir",
      contentSourceList: ["GDS"],
      PassengerCriteria: [
        { "@type": "PassengerCriteria", number: 1, passengerTypeCode: "ADT" },
      ],
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

  console.log("  Sending price request …");
  try {
    const res = await axios.post(url, body, { headers: makeHeaders(token), timeout: 30000 });
    console.log(`  HTTP ${res.status}`);

    const outPath = path.join(__dirname, "travelport-price-response.json");
    fs.writeFileSync(outPath, JSON.stringify(res.data, null, 2));

    const resp   = res.data?.OfferListResponse;
    const errors = resp?.Result?.Error || [];
    const offers = resp?.OfferList?.Offer || [];

    if (offers.length) {
      console.log(`  ✅ Priced offer received — ${offers.length} offer(s)`);
      const o = offers[0];
      console.log(`     offerId    = ${o.id}`);
      console.log(`     totalPrice = ${JSON.stringify(o.Price?.TotalPrice ?? o.Price?.Total)}`);
    } else if (errors.length) {
      errors.forEach((e) => {
        if (e.SourceCode === "3459") {
          console.log(`  ⚠️  Sandbox limitation: GDS (${e.SourceID}) error ${e.SourceCode} — "${e.Message}"`);
          console.log(`     In production, CatalogProductOfferings.Identifier (UUID) enables stateful GDS pricing.`);
          console.log(`     Fallback: using BestCombinablePrice from search (INR ${firstOffering?.ProductBrandOptions?.[0]?.ProductBrandOffering?.[0]?.BestCombinablePrice?.TotalPrice}).`);
        } else {
          console.log(`  ❌ GDS error ${e.SourceCode}: ${e.Message}`);
        }
      });
    }
    console.log(`  Full response saved → ${outPath}`);
  } catch (err) {
    console.log("  ❌ Pricing FAILED");
    console.log("     Status :", err.response?.status);
    console.log("     Body   :", JSON.stringify(err.response?.data, null, 2));
  }
}

(async () => {
  printEnv();
  const token      = await testAuth();
  const rawData    = await testSearch(token);
  const parsedData = rawData ? testParser(rawData) : null;
  await testPrice(token, parsedData);
  console.log("\n" + "═".repeat(60));
  console.log("  Done.");
  console.log("═".repeat(60) + "\n");
})();
