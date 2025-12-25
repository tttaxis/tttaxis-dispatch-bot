import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";

console.log("SERVER FILE LOADED");

const app = express();
import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";

console.log("SERVER FILE LOADED");

const app = express();
app.use(express.json());

/* =========================
   CORS (WordPress Safe)
========================= */
app.use((req, res, next) => {
  const allowed = (process.env.PUBLIC_ORIGIN || "").split(",");
  const origin = req.headers.origin;

  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

/* =========================
   CONFIG
========================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MIN_FARE_GBP = Number(process.env.MIN_FARE_GBP || 8);
const PER_MILE_GBP = Number(process.env.PER_MILE_GBP || 2.2);
const NIGHT_START_HOUR = Number(process.env.NIGHT_START_HOUR || 23);
const NIGHT_MULTIPLIER = Number(process.env.NIGHT_MULTIPLIER || 1.5);

/* =========================
   SYSTEM PROMPT
========================= */
const SYSTEM_PROMPT =
  "You are a professional UK taxi dispatch assistant. " +
  "You take taxi bookings and quote fares in GBP (£). " +
  "If pickup, dropoff, and time/date are provided, you must quote a fare immediately. " +
  "Do not ask for information that has already been provided.";

/* =========================
   DETERMINISTIC EXTRACTION
========================= */
function extractBookingFromText(text) {
  if (!text) return null;

  const lower = text.toLowerCase();

  // match "kendal to manchester airport"
  const routeMatch = lower.match(/(.+?)\s+to\s+(.+?)(\s|$)/);

  // match "23:30 25/12/2025"
  const timeDateMatch = lower.match(
    /(\d{1,2}:\d{2})\s+(\d{2}\/\d{2}\/\d{4})/
  );

  if (!routeMatch) return null;

  const pickup = routeMatch[1].trim();
  const dropoff = routeMatch[2].trim();

  let pickup_time_iso = null;

  if (timeDateMatch) {
    const [_, time, date] = timeDateMatch;
    const [day, month, year] = date.split("/");
    pickup_time_iso = `${year}-${month}-${day}T${time}:00`;
  }

  return { pickup, dropoff, pickup_time_iso };
}

/* =========================
   OSRM DISTANCE (NO GOOGLE)
========================= */
async function getDistanceMiles(pickup, dropoff) {
  const url =
    "https://router.project-osrm.org/route/v1/driving/" +
    `${encodeURIComponent(pickup)};${encodeURIComponent(dropoff)}?overview=false`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.routes || !data.routes.length) {
    throw new Error("Route not found");
  }

  const meters = data.routes[0].distance;
  return Math.round((meters / 1609.34) * 10) / 10;
}

/* =========================
   PRICING (GBP ONLY)
========================= */
function calculateFareGBP(miles, pickupTimeISO) {
  let price = Math.max(MIN_FARE_GBP, miles * PER_MILE_GBP);

  if (pickupTimeISO) {
    const hour = new Date(pickupTimeISO).getHours();
    if (hour >= NIGHT_START_HOUR) {
      price = price * NIGHT_MULTIPLIER;
    }
  }

  return Math.round(price * 100) / 100;
}

/* =========================
   OPENAI TOOL (SCHEMA SAFE)
========================= */
const tools = [
  {
    type: "function",
    name: "quote_fare",
    description: "Quote a UK taxi fare in GBP (£)",
    parameters: {
      type: "object",
      properties: {
        pickup: { type: "string" },
        dropoff: { type: "string" },
        pickup_time_iso: { type: "string" },
      },
      required: ["pickup", "dropoff"],
    },
  },
];

/* =========================
   CHAT ENDPOINT
========================= */
app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages || [];
    const lastUser = userMessages[userMessages.length - 1]?.content;

    /* ---- FORCE QUOTE IF DATA PRESENT ---- */
    const extracted = extractBookingFromText(lastUser);

    if (extracted) {
      const miles = await getDistanceMiles(
        extracted.pickup,
        extracted.dropoff
      );

      const price = calculateFareGBP(
        miles,
        extracted.pickup_time_iso
      );

      return res.json({
        reply:
          `Your journey from ${extracted.pickup} to ${extracted.dropoff} ` +
          `at ${extracted.pickup_time_iso || "the requested time"} ` +
          `is approximately ${miles} miles. ` +
          `The estimated fare is £${price}. ` +
          `Would you like me to proceed with the booking?`,
      });
    }

    /* ---- FALL BACK TO AI ---- */
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...userMessages,
    ];

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: messages,
      tools,
      tool_choice: "auto",
    });

    const output = response.output[0];

    if (output.content && output.content[0]?.text) {
      return res.json({ reply: output.content[0].text });
    }

    res.json({ reply: "How can I help you with your taxi booking?" });

  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.json({
      reply: "Sorry — connection issue. Please call.",
    });
  }
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TTTaxis backend listening on port ${PORT}`);
});

