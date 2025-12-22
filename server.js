import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import twilio from "twilio";
import { v4 as uuidv4 } from "uuid";
import Database from "better-sqlite3";

// Node 18+ has global fetch.
// ----------------------------

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const ALLOWED_ORIGINS = (process.env.PUBLIC_ORIGIN || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes("*")) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    methods: ["GET", "POST"],
  })
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Twilio
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

// SQLite
const SQLITE_PATH = process.env.SQLITE_PATH || "./data/tttaxis.db";
const dbDir = SQLITE_PATH.includes("/") ? SQLITE_PATH.split("/").slice(0, -1).join("/") : ".";
if (dbDir && dbDir !== "." ) {
  await import("node:fs/promises").then(fs=>fs.mkdir(dbDir, { recursive: true }).catch(()=>{}));
} else {
  await import("node:fs/promises").then(fs=>fs.mkdir("./data", { recursive: true }).catch(()=>{}));
}
const db = new Database(SQLITE_PATH);
db.pragma("journal_mode = WAL");

// Schema
db.exec(`
CREATE TABLE IF NOT EXISTS bookings (
  booking_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  pickup TEXT NOT NULL,
  dropoff TEXT NOT NULL,
  pickup_time_iso TEXT NOT NULL,
  passengers INTEGER NOT NULL,
  luggage TEXT,
  notes TEXT,
  miles REAL,
  duration_minutes REAL,
  quoted_total_gbp REAL NOT NULL,
  ywb_link TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT,
  direction TEXT NOT NULL, -- inbound/outbound
  from_addr TEXT,
  to_addr TEXT,
  body TEXT NOT NULL,
  created_at_iso TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drivers (
  driver_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  vehicle_type TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS assignments (
  booking_id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  assigned_at_iso TEXT NOT NULL
);
`);

function nowIso() {
  return new Date().toISOString();
}

// --------------------
// Pricing
// --------------------
function parseMoney(n) {
  const v = Number(n);
  if (Number.isNaN(v) || !Number.isFinite(v)) throw new Error("Invalid number");
  return Math.round(v * 100) / 100;
}
function hourLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid pickup_time_iso");
  return d.getHours();
}
function isNight(pickupISO) {
  const start = Number(process.env.NIGHT_START_HOUR ?? 23);
  return hourLocal(pickupISO) >= start;
}
function quoteFareGBP({ miles, pickup_time_iso }) {
  const minFare = parseMoney(process.env.MIN_FARE_GBP ?? 8.0);
  const perMile = parseMoney(process.env.PER_MILE_GBP ?? 2.2);
  const base = Math.max(minFare, parseMoney(miles) * perMile);
  const multiplier = isNight(pickup_time_iso)
    ? parseMoney(process.env.NIGHT_MULTIPLIER ?? 1.5)
    : 1.0;

  const total = Math.round(base * multiplier * 100) / 100;
  return {
    currency: "GBP",
    base: Math.round(base * 100) / 100,
    multiplier,
    total,
  };
}

// --------------------
// Google Distance Matrix
// --------------------
const fallbackDistancesMiles = [
  { fromMatch: /kendal/i, toMatch: /manchester airport/i, miles: 86.0, minutes: 95 },
  { fromMatch: /kendal/i, toMatch: /lancaster/i, miles: 21.0, minutes: 35 },
  { fromMatch: /kendal/i, toMatch: /windermere/i, miles: 9.0, minutes: 20 },
];

async function getDistanceMatrix({ pickup, dropoff }) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY not set");

  const mode = process.env.GOOGLE_DM_MODE || "driving";
  const region = process.env.GOOGLE_DM_REGION || "uk";
  const language = process.env.GOOGLE_DM_LANGUAGE || "en-GB";

  const url =
    "https://maps.googleapis.com/maps/api/distancematrix/json" +
    `?origins=${encodeURIComponent(pickup)}` +
    `&destinations=${encodeURIComponent(dropoff)}` +
    `&mode=${encodeURIComponent(mode)}` +
    `&region=${encodeURIComponent(region)}` +
    `&language=${encodeURIComponent(language)}` +
    `&units=imperial` +
    `&key=${encodeURIComponent(key)}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== "OK") {
    throw new Error(`DistanceMatrix status: ${data.status}`);
  }
  const el = data?.rows?.[0]?.elements?.[0];
  if (!el || el.status !== "OK") {
    throw new Error(`DistanceMatrix element status: ${el?.status || "UNKNOWN"}`);
  }

  const meters = el.distance.value;
  const seconds = el.duration.value;
  const miles = meters / 1609.34;
  const minutes = seconds / 60;

  return {
    miles: Math.round(miles * 10) / 10,
    duration_minutes: Math.round(minutes),
  };
}

function getFallbackDistance({ pickup, dropoff }) {
  for (const r of fallbackDistancesMiles) {
    if (r.fromMatch.test(pickup) && r.toMatch.test(dropoff)) {
      return { miles: r.miles, duration_minutes: r.minutes, fallback: true };
    }
  }
  return null;
}

// --------------------
// WhatsApp
// --------------------
async function sendWhatsApp({ to, body }) {
  if (!twilioClient) return { ok: false, error: "Twilio not configured" };
  const msg = await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to,
    body,
  });
  return { ok: true, sid: msg.sid };
}

function buildYourWebBookerLink() {
  // Conservative link to base booking page (prefill varies by setup).
  return process.env.YOURWEBBOOKER_BASE_URL || null;
}

// --------------------
// Tool definitions (OpenAI Responses API)
const tools = [
  {
    type: "function",
    function: {
      name: "estimate_distance",
      description:
        "Get trip distance (miles) and duration (minutes) using Google Distance Matrix, with a local fallback for common routes.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pickup: { type: "string", description: "Pickup address/place (UK)." },
          dropoff: { type: "string", description: "Dropoff address/place (UK)." },
        },
        required: ["pickup", "dropoff"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "quote_fare",
      description:
        "Calculate fare quote in GBP using minimum fare + mileage and apply 1.5x after 23:00.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          miles: { type: "number", description: "Trip distance in miles." },
          pickup_time_iso: { type: "string", description: "Pickup time ISO 8601." },
        },
        required: ["miles", "pickup_time_iso"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_booking_lead",
      description:
        "Create a booking lead and return booking_id and YourWebBooker link.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          customer_name: { type: "string" },
          customer_phone: { type: "string", description: "Customer phone number (E.164 preferred)." },
          pickup: { type: "string" },
          dropoff: { type: "string" },
          pickup_time_iso: { type: "string" },
          passengers: { type: "integer" },
          luggage: { type: "string" },
          notes: { type: "string" },
          miles: { type: "number" },
          duration_minutes: { type: "number" },
          quoted_total_gbp: { type: "number" },
        },
        required: [
          "customer_name",
          "customer_phone",
          "pickup",
          "dropoff",
          "pickup_time_iso",
          "passengers",
          "notes",
          "quoted_total_gbp",
        ],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "notify_dispatch_whatsapp",
      description: "Send booking details to dispatch via WhatsApp.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          booking_id: { type: "string" },
          message: { type: "string" },
        },
        required: ["booking_id", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_customer_whatsapp",
      description:
        "Send a WhatsApp message to the customer (e.g., booking received, confirmation, updates).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          customer_phone: { type: "string" },
          message: { type: "string" },
        },
        required: ["customer_phone", "message"],
      },
    },
  },
];

async function runToolCall(toolCall) {
  const { name, arguments: argsJson } = toolCall.function;
  const args = JSON.parse(argsJson || "{}");

  if (name === "estimate_distance") {
    try {
      const dm = await getDistanceMatrix(args);
      return { ...dm, fallback: false };
    } catch (e) {
      const fb = getFallbackDistance(args);
      if (fb) return fb;
      throw e;
    }
  }

  if (name === "quote_fare") {
    return quoteFareGBP(args);
  }

  if (name === "create_booking_lead") {
    const booking_id = uuidv4();
    const ywb_link = buildYourWebBookerLink();

    const stmt = db.prepare(`
      INSERT INTO bookings (
        booking_id, status, created_at_iso,
        customer_name, customer_phone,
        pickup, dropoff, pickup_time_iso,
        passengers, luggage, notes,
        miles, duration_minutes,
        quoted_total_gbp, ywb_link
      ) VALUES (
        @booking_id, @status, @created_at_iso,
        @customer_name, @customer_phone,
        @pickup, @dropoff, @pickup_time_iso,
        @passengers, @luggage, @notes,
        @miles, @duration_minutes,
        @quoted_total_gbp, @ywb_link
      )
    `);

    stmt.run({
      booking_id,
      status: "NEW",
      created_at_iso: nowIso(),
      customer_name: args.customer_name,
      customer_phone: args.customer_phone,
      pickup: args.pickup,
      dropoff: args.dropoff,
      pickup_time_iso: args.pickup_time_iso,
      passengers: args.passengers,
      luggage: args.luggage || "",
      notes: args.notes || "",
      miles: args.miles ?? null,
      duration_minutes: args.duration_minutes ?? null,
      quoted_total_gbp: args.quoted_total_gbp,
      ywb_link,
    });

    return { booking_id, ywb_link };
  }

  if (name === "notify_dispatch_whatsapp") {
    const to = process.env.DISPATCH_WHATSAPP_TO;
    const result = await sendWhatsApp({ to, body: args.message });
    if (result.ok) {
      db.prepare(
        `INSERT INTO messages (booking_id, direction, from_addr, to_addr, body, created_at_iso)
         VALUES (?, 'outbound', ?, ?, ?, ?)`
      ).run(args.booking_id, process.env.TWILIO_WHATSAPP_FROM, to, args.message, nowIso());
    }
    return result;
  }

  if (name === "send_customer_whatsapp") {
    const to = `whatsapp:${args.customer_phone.replace(/^whatsapp:/, "")}`;
    const result = await sendWhatsApp({ to, body: args.message });
    if (result.ok) {
      db.prepare(
        `INSERT INTO messages (booking_id, direction, from_addr, to_addr, body, created_at_iso)
         VALUES (NULL, 'outbound', ?, ?, ?, ?)`
      ).run(process.env.TWILIO_WHATSAPP_FROM, to, args.message, nowIso());
    }
    return result;
  }

  throw new Error(`Unknown tool: ${name}`);
}

// --------------------
// System prompt
const SYSTEM = `
You are TTTaxis Dispatch Assistant for a UK taxi operator.

Objective:
- Take booking requests, estimate distance via tool, quote price using min fare + mileage and night multiplier after 23:00,
- Create a booking lead,
- Notify dispatch via WhatsApp,
- Optionally send a WhatsApp acknowledgement to the customer.

Operating rules:
- Collect: pickup, dropoff, pickup date/time, passengers.
- Confirm phone number (UK), name, and any luggage/accessibility needs.
- Use estimate_distance once you have pickup and dropoff.
- Use quote_fare once you have miles and pickup_time_iso.
- Present the quote clearly as GBP and mention night rate if applicable.
- Ask for confirmation: "Shall I submit this to dispatch now?"
- If yes: create_booking_lead, then notify_dispatch_whatsapp with a clean one-message summary.
- After submitting, offer a YourWebBooker link for card payment/confirmation.
- Always provide a fallback: "Call 01539 556160" if anything fails or urgency is high.
- Do not claim a driver is assigned unless dispatch confirms.
`;

// --------------------
// Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: "messages must be an array" });

    let response = await openai.responses.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      input: [{ role: "system", content: SYSTEM }, ...messages],
      tools,
    });

    // Loop tool calls
    while (response.output?.some((o) => o.type === "tool_call")) {
      const toolCalls = response.output.filter((o) => o.type === "tool_call");
      const toolOutputs = [];
      for (const tc of toolCalls) {
        const out = await runToolCall(tc);
        toolOutputs.push({ type: "tool_output", tool_call_id: tc.id, output: JSON.stringify(out) });
      }

      response = await openai.responses.create({
        model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
        input: [{ role: "system", content: SYSTEM }, ...messages, ...toolOutputs],
        tools,
      });
    }

    const textParts = (response.output || [])
      .filter((o) => o.type === "message")
      .flatMap((m) => m.content || [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text);

    res.json({ reply: textParts.join("\n") });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// --------------------
// Twilio inbound WhatsApp (two-way)
app.post("/twilio/whatsapp", async (req, res) => {
  try {
    const from = req.body.From; // whatsapp:+44...
    const to = req.body.To;
    const body = (req.body.Body || "").trim();

    // Log inbound message
    db.prepare(
      `INSERT INTO messages (booking_id, direction, from_addr, to_addr, body, created_at_iso)
       VALUES (NULL, 'inbound', ?, ?, ?, ?)`
    ).run(from, to, body, nowIso());

    // Best-effort: find most recent booking by this phone
    const row = db
      .prepare(
        `SELECT booking_id FROM bookings WHERE customer_phone = ? ORDER BY created_at_iso DESC LIMIT 1`
      )
      .get(from.replace(/^whatsapp:/, ""));

    if (row?.booking_id) {
      // Update status if customer says confirm/cancel
      const lower = body.toLowerCase();
      if (/\bcancel\b/.test(lower)) {
        db.prepare(`UPDATE bookings SET status='CANCEL_REQUESTED' WHERE booking_id=?`).run(row.booking_id);
      } else if (/\bconfirm\b/.test(lower) || /\byes\b/.test(lower)) {
        db.prepare(`UPDATE bookings SET status='CUSTOMER_CONFIRMED' WHERE booking_id=?`).run(row.booking_id);
      }
      // Notify dispatch that customer replied
      const dispatchMsg = `Customer reply for booking ${row.booking_id}:\n${body}`;
      if (process.env.DISPATCH_WHATSAPP_TO) {
        await sendWhatsApp({ to: process.env.DISPATCH_WHATSAPP_TO, body: dispatchMsg });
      }
    }

    // Twilio expects 200 OK; respond with empty TwiML to avoid auto-reply
    res.set("Content-Type", "text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  } catch (e) {
    console.error(e);
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }
});

// --------------------
// Basic admin endpoints (scaffolding)
function requireAdmin(req, res, next) {
  // Lightweight: require a header token (set this behind Cloudflare/SG auth for real use)
  const token = req.header("x-tttaxis-admin");
  if (!token || token !== (process.env.ADMIN_TOKEN || "change-me")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/admin/bookings", requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT * FROM bookings ORDER BY created_at_iso DESC LIMIT 200`).all();
  res.json({ bookings: rows });
});

app.post("/admin/assign-driver", requireAdmin, (req, res) => {
  // Driver app later: for now dispatch can assign a driver id
  const { booking_id, driver_id } = req.body || {};
  if (!booking_id || !driver_id) return res.status(400).json({ error: "booking_id and driver_id required" });

  const booking = db.prepare(`SELECT booking_id FROM bookings WHERE booking_id=?`).get(booking_id);
  const driver = db.prepare(`SELECT driver_id FROM drivers WHERE driver_id=?`).get(driver_id);
  if (!booking) return res.status(404).json({ error: "booking not found" });
  if (!driver) return res.status(404).json({ error: "driver not found" });

  db.prepare(
    `INSERT INTO assignments (booking_id, driver_id, assigned_at_iso)
     VALUES (?, ?, ?)
     ON CONFLICT(booking_id) DO UPDATE SET driver_id=excluded.driver_id, assigned_at_iso=excluded.assigned_at_iso`
  ).run(booking_id, driver_id, nowIso());

  db.prepare(`UPDATE bookings SET status='DRIVER_ASSIGNED' WHERE booking_id=?`).run(booking_id);

  res.json({ ok: true });
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TTTaxis backend listening on port ${PORT}`);
});

