import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";

console.log("SERVER FILE LOADED");

const app = express();
app.use(express.json());

/* =========================
   CONFIG
========================= */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MIN_FARE = Number(process.env.MIN_FARE_GBP || 8);
const PER_MILE = Number(process.env.PER_MILE_GBP || 2.2);
const NIGHT_START = Number(process.env.NIGHT_START_HOUR || 23);
const NIGHT_MULTIPLIER = Number(process.env.NIGHT_MULTIPLIER || 1.5);

/* =========================
   UTIL: OSRM DISTANCE
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
  const miles = meters / 1609.34;

  return Math.round(miles * 10) / 10;
}

/* =========================
   UTIL: PRICING
========================= */

function calculateFare(miles, pickupTimeISO) {
  let price = Math.max(MIN_FARE, miles * PER_MILE);

  if (pickupTimeISO) {
    const hour = new Date(pickupTimeISO).getHours();
    if (hour >= NIGHT_START) {
      price = price * NIGHT_MULTIPLIER;
    }
  }

  return Math.round(price * 100) / 100;
}

/* =========================
   OPENAI TOOLS (FIXED)
========================= */

const tools = [
  {
    type: "function",
    name: "quote_fare",
    description: "Calculate a taxi fare based on pickup, dropoff, and time",
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
    const messages = req.body.messages || [];

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: messages,
      tools,
      tool_choice: "auto",
    });

    const output = response.output[0];

    // TOOL CALL
    if (output.type === "tool_call") {
      const { name, arguments: args } = output;

      if (name === "quote_fare") {
        const miles = await getDistanceMiles(args.pickup, args.dropoff);
        const price = calculateFare(miles, args.pickup_time_iso);

        return res.json({
          reply: `That journey is approximately ${miles} miles. The estimated fare is £${price}. Would you like me to book this for you?`,
        });
      }
    }

    // NORMAL TEXT RESPONSE
    if (output.content?.[0]?.text) {
      return res.json({ reply: output.content[0].text });
    }

    res.json({ reply: "How can I help you with your taxi booking?" });

  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.json({
      reply: "Sorry — I couldn't process that. Please call.",
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

