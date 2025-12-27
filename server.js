import express from "express";
import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";

console.log("SERVER FILE LOADED");

const app = express();
app.use(express.json());

/* ======================================================
   BASIC CORS
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
   CONFIG
====================================================== */
const MIN_FARE_GBP = Number(process.env.MIN_FARE_GBP || 4.2);
const PER_MILE_GBP = Number(process.env.PER_MILE_GBP || 2.2);
const NIGHT_START_HOUR = Number(process.env.NIGHT_START_HOUR || 23);
const NIGHT_MULTIPLIER = Number(process.env.NIGHT_MULTIPLIER || 1.5);

const FIXED_ROUTE_FARES = [
  { from: "Lancaster", to: "Manchester Airport", price: 90.00 },
  { from: "Kendal", to: "Manchester Airport", price: 120.00 },
  { from: "Kendal", to: "Leeds Bradford Airport", price: 98.00 },
  { from: "Lancaster", to: "Leeds Bradford Airport", price: 111.00 },
  { from: "Kendal", to: "Liverpool John Lennon Airport", price: 132.00 },
  { from: "Lancaster", to: "Liverpool John Lennon Airport", price: 102.00 }
];

const DATA_DIR = process.env.DATA_DIR || "/tmp/tttaxis";
const BOOKINGS_PATH = path.join(DATA_DIR, "bookings.json");

/* ======================================================
   STORAGE
====================================================== */
function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BOOKINGS_PATH)) fs.writeFileSync(BOOKINGS_PATH, "[]");
}

function readBookings() {
  ensureStorage();
  return JSON.parse(fs.readFileSync(BOOKINGS_PATH, "utf8"));
}

function writeBookings(data) {
  ensureStorage();
  fs.writeFileSync(BOOKINGS_PATH, JSON.stringify(data, null, 2));
}

function newBookingRef() {
  return `TTT-${Math.floor(10000 + Math.random() * 90000)}`;
}

/* ======================================================
   EMAIL
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

async function sendBookingEmails(booking) {
  if (!mailer) return;

  try {
    if (booking.customer_email) {
      await mailer.sendMail({
        from: process.env.FROM_EMAIL,
        to: booking.customer_email,
        subject: `TTTaxis Booking Confirmation – ${booking.id}`,
        text:
          `Thank you for booking with TTTaxis.\n\n` +
          `Reference: ${booking.id}\n` +
          `Pickup: ${booking.pickup}\n` +
          `Dropoff: ${booking.dropoff}\n` +
          `Time: ${booking.pickup_time_iso || "ASAP"}\n` +
          `Fare: £${booking.price_gbp}\n\nTTTaxis`
      });
    }

    await mailer.sendMail({
      from: process.env.FROM_EMAIL,
      to: process.env.DISPATCH_EMAIL,
      subject: `NEW BOOKING – ${booking.id}`,
      text:
        `New booking received\n\n` +
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
   GEO (UK ONLY + BIAS)
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
   ROUTING & PRICING
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

function getFixedRouteFare(pickup, dropoff) {
  const p = pickup.toLowerCase();
  const d = dropoff.toLowerCase();

  for (const route of FIXED_ROUTE_FARES) {
    const from = route.from.toLowerCase();
    const to = route.to.toLowerCase();

    if (
      (p.includes(from) && d.includes(to)) ||
      (p.includes(to) && d.includes(from))
    ) {
      return route.price;
    }
  }
  return null;
}

/* ======================================================
   QUOTE
====================================================== */
app.post("/quote", async (req, res) => {
  try {
    const { pickup, dropoff, pickup_time_iso } = req.body;

    const fixedFare = getFixedRouteFare(pickup, dropoff);
    if (fixedFare !== null) {
      let price = fixedFare;
      if (
        pickup_time_iso &&
        new Date(pickup_time_iso).getHours() >= NIGHT_START_HOUR
      ) {
        price *= NIGHT_MULTIPLIER;
      }

      return res.json({
        fixed: true,
        price_gbp: Math.round(price * 100) / 100
      });
    }

    const miles = await getMiles(pickup, dropoff);
    const price = calculateFareGBP(miles, pickup_time_iso);

    res.json({ fixed: false, miles, price_gbp: price });
  } catch {
    res.status(500).json({ error: "Unable to calculate price" });
  }
});

/* ======================================================
   BOOK
====================================================== */
app.post("/book", async (req, res) => {
  try {
    const {
      pickup,
      dropoff,
      pickup_time_iso,
      name,
      phone,
      email,
      notes
    } = req.body;

    const fixedFare = getFixedRouteFare(pickup, dropoff);

    let miles = null;
    let price;

    if (fixedFare !== null) {
      price = fixedFare;
      if (
        pickup_time_iso &&
        new Date(pickup_time_iso).getHours() >= NIGHT_START_HOUR
      ) {
        price *= NIGHT_MULTIPLIER;
      }
    } else {
      miles = await getMiles(pickup, dropoff);
      price = calculateFareGBP(miles, pickup_time_iso);
    }

    const booking = {
      id: newBookingRef(),
      created_at: new Date().toISOString(),
      pickup,
      dropoff,
      pickup_time_iso: pickup_time_iso || null,
      miles,
      price_gbp: Math.round(price * 100) / 100,
      fixed_fare: fixedFare !== null,
      customer_name: name,
      customer_phone: phone,
      customer_email: email || null,
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
   HEALTH
====================================================== */
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
;
