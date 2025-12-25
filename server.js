import express from "express";

console.log("SERVER FILE LOADED");

const app = express();
app.use(express.json());

/* ======================================================
   GLOBAL OPTIONS HANDLER (CRITICAL FOR RAILWAY)
====================================================== */
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  next();
});

/* ======================================================
   CORS FOR NORMAL REQUESTS
====================================================== */
app.use((req, res, next) => {
  const allowed = (process.env.PUBLIC_ORIGIN || "").split(",");
  const origin = req.headers.origin;

  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  next();
});

/* ======================================================
   CONFIG (GBP ONLY)
====================================================== */
const MIN_FARE_GBP = Number(process.env.MIN_FARE_GBP || 8);
const PER_MILE_GBP = Number(process.env.PER_MILE_GBP || 2.2);
const NIGHT_START_HOUR = Number(process.env.NIGHT_START_HOUR || 23);
const NIGHT_MULTIPLIER = Number(process.env.NIGHT_MULTIPLIER || 1.5);

/* ======================================================
   SIMPLE UK BOOKING EXTRACTION
====================================================== */
function extractBooking(text) {
  if (!text) return null;

  const lower = text.toLowerCase();

  const route = lower.match(/(.+?)\s+to\s+(.+?)(\s|$)/);
  const timeDate = lower.match(
    /(\d{1,2}:\d{2})\s+(\d{2}\/\d{2}\/\d{4})/
  );

  if (!route) return null;

  let pickup_time_iso = null;

  if (timeDate) {
    const [, time, date] = timeDate;
    const [day, month, year] = date.split("/");
    pickup_time_iso = `${year}-${month}-${day}T${time}:00`;
  }

  return {
    pickup: route[1].trim(),
    dropoff: route[2].trim(),
    pickup_time_iso,
  };
}

/* ======================================================
   OSRM DISTANCE (BUILT-IN FETCH)
====================================================== */
async function getMiles(pickup, dropoff) {
  const url =
    "https://router.project-osrm.org/route/v1/driving/" +
    `${encodeURIComponent(pickup)};${encodeURIComponent(dropoff)}?overview=false`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.routes || !data.routes.length) {
    throw new Error("Route not found");
  }

  return Math.round((data.routes[0].distance / 1609.34) * 10) / 10;
}

/* ======================================================
   PRICING (GBP)
====================================================== */
function calculateFare(miles, isoTime) {
  let price = Math.max(MIN_FARE_GBP, miles * PER_MILE_GBP);

  if (isoTime) {
    const hour = new Date(isoTime).getHours();
    if (hour >= NIGHT_START_HOUR) {
      price *= NIGHT_MULTIPLIER;
    }
  }

  return Math.round(price * 100) / 100;
}

/* ======================================================
   EXPLICIT PREFLIGHT FOR /chat (REQUIRED)
====================================================== */
app.options("/chat", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.status(200).end();
});

/* ======================================================
   CHAT ENDPOINT
====================================================== */
app.post("/chat", async (req, res) => {
  try {
    const messages = req.body.messages || [];
    const last = messages[messages.length - 1]?.content;

    const booking = extractBooking(last);

    if (!booking) {
      return res.json({
        reply:
          "I can take a booking. Please tell me your pickup, dropoff, date and time.",
      });
    }

    const miles = await getMiles(booking.pickup, booking.dropoff);
    const price = calculateFare(miles, booking.pickup_time_iso);

    return res.json({
      reply:
        `Your journey from ${booking.pickup} to ${booking.dropoff} ` +
        `at ${booking.pickup_time_iso || "the requested time"} ` +
        `is approximately ${miles} miles. ` +
        `The estimated fare is £${price}. ` +
        `Would you like me to proceed with the booking?`,
    });

  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.json({
      reply: "Sorry — connection issue. Please call.",
    });
  }
});

/* ======================================================
   HEALTH CHECK
====================================================== */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* ======================================================
   START SERVER (RAILWAY SAFE)
====================================================== */
const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TTTaxis backend listening on port ${PORT}`);
});

