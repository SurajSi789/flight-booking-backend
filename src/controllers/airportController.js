const { success } = require("../utils/apiResponse");

const AIRPORTS = [
  // ── Metros ──────────────────────────────────────────────────────────────────
  { code: "DEL", city: "New Delhi",      name: "Indira Gandhi International Airport",               country: "India" },
  { code: "BOM", city: "Mumbai",         name: "Chhatrapati Shivaji Maharaj International Airport", country: "India" },
  { code: "BLR", city: "Bengaluru",      name: "Kempegowda International Airport",                  country: "India" },
  { code: "MAA", city: "Chennai",        name: "Chennai International Airport",                     country: "India" },
  { code: "HYD", city: "Hyderabad",      name: "Rajiv Gandhi International Airport",                country: "India" },
  { code: "CCU", city: "Kolkata",        name: "Netaji Subhas Chandra Bose International Airport",  country: "India" },
  // ── Tier-2 hubs ──────────────────────────────────────────────────────────────
  { code: "AYJ", city: "Ayodhya",        name: "Maharshi Valmiki International Airport",            country: "India" },
  { code: "AMD", city: "Ahmedabad",      name: "Sardar Vallabhbhai Patel International Airport",    country: "India" },
  { code: "COK", city: "Kochi",          name: "Cochin International Airport",                      country: "India" },
  { code: "PNQ", city: "Pune",           name: "Pune International Airport",                        country: "India" },
  { code: "JAI", city: "Jaipur",         name: "Jaipur International Airport",                      country: "India" },
  { code: "GOI", city: "Goa",            name: "Goa International Airport (Dabolim)",               country: "India" },
  { code: "GOX", city: "Goa (Mopa)",     name: "Manohar International Airport",                     country: "India" },
  { code: "LKO", city: "Lucknow",        name: "Chaudhary Charan Singh International Airport",      country: "India" },
  { code: "ATQ", city: "Amritsar",       name: "Sri Guru Ram Dass Jee International Airport",       country: "India" },
  { code: "BBI", city: "Bhubaneswar",    name: "Biju Patnaik International Airport",                country: "India" },
  { code: "GAU", city: "Guwahati",       name: "Lokpriya Gopinath Bordoloi International Airport",  country: "India" },
  { code: "IXC", city: "Chandigarh",     name: "Shaheed Bhagat Singh International Airport",        country: "India" },
  { code: "IXE", city: "Mangaluru",      name: "Mangaluru International Airport",                   country: "India" },
  { code: "IXZ", city: "Port Blair",     name: "Veer Savarkar International Airport",               country: "India" },
  { code: "IMF", city: "Imphal",         name: "Bir Tikendrajit International Airport",             country: "India" },
  { code: "SXR", city: "Srinagar",       name: "Sheikh ul Alam International Airport",              country: "India" },
  { code: "TRV", city: "Thiruvananthapuram", name: "Trivandrum International Airport",              country: "India" },
  { code: "NAG", city: "Nagpur",         name: "Dr. Babasaheb Ambedkar International Airport",      country: "India" },
  { code: "VTZ", city: "Visakhapatnam", name: "Visakhapatnam International Airport",                country: "India" },
  { code: "IXB", city: "Bagdogra",       name: "Bagdogra Airport (Siliguri)",                       country: "India" },
  { code: "CCJ", city: "Kozhikode",      name: "Calicut International Airport",                     country: "India" },
  { code: "VEY", city: "Kannur",         name: "Kannur International Airport",                      country: "India" },
  { code: "IDR", city: "Indore",         name: "Devi Ahilyabai Holkar Airport",                     country: "India" },
  { code: "BHO", city: "Bhopal",         name: "Raja Bhoj Airport",                                 country: "India" },
  { code: "IXR", city: "Ranchi",         name: "Birsa Munda Airport",                               country: "India" },
  { code: "PAT", city: "Patna",          name: "Jay Prakash Narayan International Airport",         country: "India" },
  { code: "BDQ", city: "Vadodara",       name: "Vadodara Airport",                                  country: "India" },
  { code: "VNS", city: "Varanasi",       name: "Lal Bahadur Shastri International Airport",         country: "India" },
  { code: "CJB", city: "Coimbatore",     name: "Coimbatore International Airport",                  country: "India" },
  { code: "TRZ", city: "Tiruchirappalli", name: "Tiruchirappalli International Airport",            country: "India" },
  { code: "IXM", city: "Madurai",        name: "Madurai Airport",                                   country: "India" },
  { code: "TIR", city: "Tirupati",       name: "Tirupati Airport",                                  country: "India" },
  { code: "VGA", city: "Vijayawada",     name: "Vijayawada International Airport",                  country: "India" },
  { code: "RJA", city: "Rajahmundry",    name: "Rajahmundry Airport",                               country: "India" },
  { code: "CDP", city: "Kadapa",         name: "Kadapa Airport",                                    country: "India" },
  { code: "IXU", city: "Chhatrapati Sambhajinagar", name: "Chhatrapati Sambhajinagar Airport",      country: "India" },
  { code: "RPR", city: "Raipur",         name: "Swami Vivekananda Airport",                         country: "India" },
  { code: "JDH", city: "Jodhpur",        name: "Jodhpur Airport",                                   country: "India" },
  { code: "UDR", city: "Udaipur",        name: "Maharana Pratap Airport",                           country: "India" },
  { code: "IXJ", city: "Jammu",          name: "Jammu Airport",                                     country: "India" },
  { code: "IXL", city: "Leh",            name: "Kushok Bakula Rimpochhe Airport",                   country: "India" },
  { code: "DED", city: "Dehradun",       name: "Jolly Grant Airport",                               country: "India" },
  { code: "SLV", city: "Shimla",         name: "Shimla Airport",                                    country: "India" },
  { code: "KUU", city: "Kullu-Manali",   name: "Kullu-Manali Airport (Bhuntar)",                    country: "India" },
  { code: "AGR", city: "Agra",           name: "Agra Airport",                                      country: "India" },
  { code: "GWL", city: "Gwalior",        name: "Gwalior Airport",                                   country: "India" },
  { code: "JLR", city: "Jabalpur",       name: "Jabalpur Airport",                                  country: "India" },
  { code: "IXD", city: "Prayagraj",      name: "Prayagraj Airport",                                 country: "India" },
  { code: "GOP", city: "Gorakhpur",      name: "Gorakhpur Airport",                                 country: "India" },
  { code: "HJR", city: "Khajuraho",      name: "Khajuraho Airport",                                 country: "India" },
  { code: "BEK", city: "Bareilly",       name: "Bareilly Airport",                                  country: "India" },
  { code: "GAY", city: "Gaya",           name: "Gaya Airport",                                      country: "India" },
  { code: "IXG", city: "Belagavi",       name: "Belagavi Airport",                                  country: "India" },
  { code: "HBX", city: "Hubballi",       name: "Hubballi Airport",                                  country: "India" },
  { code: "IXA", city: "Agartala",       name: "Maharaja Bir Bikram Airport",                       country: "India" },
  { code: "AJL", city: "Aizawl",         name: "Lengpui Airport",                                   country: "India" },
  { code: "IXS", city: "Silchar",        name: "Silchar Airport",                                   country: "India" },
  { code: "DMU", city: "Dimapur",        name: "Dimapur Airport",                                   country: "India" },
  { code: "IXI", city: "Lilabari",       name: "Lilabari Airport (North Lakhimpur)",                country: "India" },
  { code: "JRH", city: "Jorhat",         name: "Jorhat Airport",                                    country: "India" },
  { code: "DIB", city: "Dibrugarh",      name: "Dibrugarh Airport",                                 country: "India" },
  { code: "TEZ", city: "Tezpur",         name: "Tezpur Airport",                                    country: "India" },
  { code: "IXN", city: "Khowai",         name: "Khowai Airport",                                    country: "India" },
  { code: "SHL", city: "Shillong",       name: "Shillong Airport (Umroi)",                          country: "India" },
  { code: "JGA", city: "Jamnagar",       name: "Jamnagar Airport",                                  country: "India" },
  { code: "PBD", city: "Porbandar",      name: "Porbandar Airport",                                 country: "India" },
  { code: "IXP", city: "Pathankot",      name: "Pathankot Airport",                                 country: "India" },
  { code: "DBR", city: "Darbhanga",      name: "Darbhanga Airport",                                 country: "India" },
  { code: "HDO", city: "Deoghar",        name: "Deoghar Airport",                                   country: "India" },
  { code: "JRG", city: "Jharsuguda",     name: "Veer Surendra Sai Airport",                         country: "India" },
  { code: "KQH", city: "Kishangarh",     name: "Kishangarh Airport",                                country: "India" },
  { code: "MZU", city: "Muzaffarpur",    name: "Muzaffarpur Airport",                               country: "India" },
  { code: "HGI", city: "Itanagar",       name: "Donyi Polo Airport",                                country: "India" },
  { code: "BKB", city: "Bikaner",        name: "Nal Airport",                                       country: "India" },
  { code: "ZER", city: "Ziro",           name: "Ziro Airport",                                      country: "India" },
];

const searchAirports = async (req, res) => {
  const q = String(req.query.q || "")
    .trim()
    .toLowerCase();
  const rows = q
    ? AIRPORTS.filter(
        (a) =>
          a.code.toLowerCase().includes(q) ||
          a.city.toLowerCase().includes(q) ||
          a.name.toLowerCase().includes(q)
      )
    : AIRPORTS;
  return res.json(success(rows, "Airports fetched"));
};

const { getNearbyForAirport } = require("../services/nearbyAirports");

const getNearby = async (req, res) => {
  const code = String(req.params.code || "")
    .trim()
    .toUpperCase()
    .slice(0, 3);
  if (!/^[A-Z]{3}$/.test(code)) {
    return res.status(400).json({ success: false, message: "Invalid airport code" });
  }
  const rows = getNearbyForAirport(code);
  return res.json(success(rows, "Nearby airports"));
};

module.exports = {
  searchAirports,
  getNearby
};
