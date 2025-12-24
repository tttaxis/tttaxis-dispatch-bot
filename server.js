import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";

console.log("SERVER FILE LOADED");

const app = express();
app.use(express.json());

/* =========================
   CORS (WORDPRESS SAFE)
========================= */

app.use((req, res, next) => {
  const allowed = (process.env.PUBLIC_ORIGIN || "").split(",");
  const origin = req.headers.origin;

  if (allowed.includes(origin)) {
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

const MIN_FARE = Number(process.env.MIN_FARE_GBP || 8);
const PER_MILE = Number(process.env.PER_MILE_GBP || 2.2);
const NIGHT_START = Number(process.env.NIGHT_START_HOUR || 23);
const NIGHT_MULTIPLIER = Number(process.env.NIGHT_MULTIPLIER || 1.5);

/* =========================
   SYSTEM PROMPT (CRITICAL)
========================= */

const SYSTEM_PROMPT = `
You are a professional UK taxi dispatch assistant.

Your job is to take taxi bookings efficiently.

Rules:
- Always extract pickup location, dropoff location, date, and time if provided.
- If pickup and dropoff are known AND a date/time is known, you MUST call the quote_fare tool.
- Do NOT ask repeated questions if information has already been provided.
- After quoting a fare, ask if the customer wants to proceed with the booking.
- Be concise, professional, and transactional.
`;

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
  const miles = meters / 1609.34;

  return Math.round(miles * 10) / 10;
}

/* =========================
   PRICING
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
        pickup_time_iso: { type: "string" }
      },
      required: ["pickup", "dropoff"]
    }
  }
];

/* =========================
   CHAT ENDPOINT
========================= */

app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages || [];

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...userMessages
    ];

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: messages,
      tools,
      tool_choice: "auto"
    });

    const output = response.output[0];

    // TOOL CALL
    if (output.type === "tool_call") {
      const { name, argum
