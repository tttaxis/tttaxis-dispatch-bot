import express from "express";
import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";

console.log("SERVER FILE LOADED");

const app = express();
app.use(express.json());

/* ======================================================
   OPTIONS + CORS
====================================================== */
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
    return res.status(200).end();
  }
  next();
});

app.use((req, res, next) => {
  const allowed = (process.env.PUBLIC_ORIGIN || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);

  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  next();
});

/* ======================================================
   CONFIG
====================================================== */
const MIN_FARE_GBP = Number(process.env.MIN_FARE_GBP || 4.2);
const PER_MILE_GBP = Number(process.env.PER_MILE_GBP || 2.2);
const NIGHT_START_HOUR = Number(process.env.NIGHT_START_HOUR || 23);
const NIGHT_MULTIPLIER = Number(process.env.NIGHT_MULTIPLIER || 1.5);

const DATA_DIR = process.env.DATA_DIR || "/tmp/tttaxis";
const BOOKINGS_PATH = path.join(DATA_DIR, "bookings.json");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

/* ======================================================
   STORAGE
====================================================== */
function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BOOKINGS_PATH)) fs.writeFileSync(BOOKINGS_PATH, "[]", "utf8");
}

function readBookings() {
  ensureStorage();
  return JSON.parse(fs.readFileSync(BOOKINGS_PATH, "utf8"));
}

function writeBookings(data) {
  ensureStorage();
  fs.writeFileSync(BOOKINGS_PATH, JSON.stringify(data, null, 2), "utf8");
}

function newBookingRef() {
  return `TTT-${Math.floor(10000 + Math.random() * 90000)}`;
}

/* ======================================================
   EMAIL TRANSPORT
====================================================== */
let mailer = null;

if (process.env.EMAIL_HOST) {
  mailer = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT || 587),
    secure: process.env.EMAIL_SECURE === "true",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
}

/* ======================================================
   EMAIL HELPERS
====================================================== */
async function sendBookingEmails(booking) {
  if (!mailer) return;

  const subject = `TTTaxis Booking Confirmation – ${booking.id}`;

  const body =
    `Thank you for booking with TTTaxis.\n\n` +
    `Booking reference: ${booking.id}\n` +
    `Pickup: ${booking.pickup}\n` +
    `Dropoff: ${booking.dropoff}\n` +
    (booking.pickup_time_iso ? `Date & Time: ${booking.pickup_time_iso}\n` : "") +
    `Estimated fare: £${booking.price_gbp}\n\n` +
    `We will contact you shortly to confirm your driver.\n\n` +
    `TTTaxis`;

  try {
    // Customer email (if provided later)
    if (booking.customer_email) {
      await mailer.sendMail({
        from: process.env.FROM_EMAIL,
        to: booking.customer_email,
        subject,
        text: body
      });
    }

    // Dispatch email
    await mailer.sendMail({
      from: process.env.FROM_EMAIL,
      to: process.env.DISPATCH_EMAIL,
      subject: `NEW BOOKING – ${booking.id}`,
      text:
        `New booking received:\n\n` +
        `Ref: ${booking.id}\n` +
        `Pickup: ${booking.pickup}\n` +
        `Dropoff: ${booking.dropoff}\n` +
        `Time: ${booking.pickup_time_iso || "ASAP"}\n` +
        `Fare: £${booking.price_gbp}\n` +
        `Customer: ${booking.customer_name}\n` +
        `Phone: ${booking.customer_phone}`
    });
  } catch (err) {
    console.error("EMAIL ERROR:", err.message);
  }
}

/* ======================================================
   GEOCODING (UK-ONLY + BIAS)
====================================================== */
async function geocode(place) {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(place)}` +
    `&countrycodes=gb` +
    `&viewbox=-4.8,55.2,-2.2,53.5` +
    `&bounded=1&format=json&limit=1`;

  const res = await fetch(url, {
    headers: { "User-Agent": "TTTaxis-Booking/1.0" }
  });

  const data = await res.json();
  if (!data || !data.length) throw new Error("Geocode failed");

  return { lat: +data[0].lat, lon: +data[0].lon };
}

/* ======================================================
   DISTANCE + PRICING
====================================================== */
async function getMiles(pickup, dropoff) {
  const a = await geocode(pickup);
  const b = await geocode(dropoff);

  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;

  const res = await fetch(url);
  const data = await res.json();
  if (!data.routes?.length) throw new Error("Route not found");

  return Math.round((data.routes[0].distance / 1609.34) * 10) / 10;
}

function calculateFareGBP(miles, isoTime) {
  let price = Math.max(MIN_FARE_GBP, miles * PER_MILE_GBP);
  if (isoTime && new Date(isoTime).getHours() >= NIGHT_START_HOUR) {
    price *= NIGHT_MULTIPLIER;
  }
  return Math.round(price * 100) / 100;
}

/* ======================================================
   QUOTE
====================================================== */
app.post("/quote", async (req, res) => {
  try {
    const { pickup, dropoff, pickup_time_iso } = req.body;
    const miles = await getMiles(pickup, dropoff);
    const price = calculateFareGBP(miles, pickup_time_iso);
    res.json({ miles, price_gbp: price });
  } catch {
    res.status(500).json({ error: "Unable to calculate price" });
  }
});

/* ======================================================
   BOOK
====================================================== */
app.post("/book", async (req, res) => {
  try {
    const { pickup, dropoff, pickup_time_iso, name, phone, notes } = req.body;

    const miles = await getMiles(pickup, dropoff);
    const price = calculateFareGBP(miles, pickup_time_iso);

    const booking = {
      id: newBookingRef(),
      created_at: new Date().toISOString(),
      pickup,
      dropoff,
      pickup_time_iso: pickup_time_iso || null,
      miles,
      price_gbp: price,
      customer_name: name,
      customer_phone: phone,
      notes: notes || "",
      status: pickup_time_iso ? "SCHEDULED" : "ASAP"
    };

    const bookings = readBookings();
    bookings.unshift(booking);
    writeBookings(bookings);

    sendBookingEmails(booking);

    res.json({ success: true, booking });
  } catch (err) {
    console.error("BOOK ERROR:", err.message);
    res.status(500).json({ error: "Booking failed" });
  }
});

/* ======================================================
   ADMIN + HEALTH
====================================================== */
app.get("/admin/bookings", (req, res) => {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ bookings: readBookings() });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* ======================================================
   START
====================================================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`TTTaxis backend listening on port ${PORT}`);
});
