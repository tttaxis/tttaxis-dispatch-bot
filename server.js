import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import nodemailer from "nodemailer";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 8080;

/* =========================
   MIDDLEWARE
========================= */
app.use(cors({ origin: "*", methods: ["POST", "GET"] }));
app.use(bodyParser.json());

/* =========================
   SMTP TEST LOGGING
========================= */
console.log("SMTP ENV CHECK", {
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  user: process.env.SMTP_USER,
  hasPass: !!process.env.SMTP_PASS
});

/* =========================
   MAIL TRANSPORT (DEBUG)
========================= */
const mailer = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  logger: true,
  debug: true
});

/* =========================
   TEST EMAIL ROUTE
========================= */
app.get("/test-email", async (req, res) => {
  try {
    const info = await mailer.sendMail({
      from: `"TTTaxis Test" <${process.env.SMTP_USER}>`,
      to: process.env.SMTP_USER,
      subject: "TTTaxis SMTP Test",
      text: "This is a test email from your Railway backend."
    });

    console.log("EMAIL SENT", info.messageId);

    res.json({
      success: true,
      messageId: info.messageId
    });

  } catch (err) {
    console.error("EMAIL TEST FAILED", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/* =========================
   QUOTE (KEEP WORKING)
========================= */
const MIN_FARE = 4.20;
const PER_MILE = 2.20;

app.post("/quote", (req, res) => {
  const { pickup, dropoff } = req.body;

  if (!pickup || !dropoff) {
    return res.status(400).json({ error: "Missing locations" });
  }

  // Dummy miles for test
  const miles = 10;
  const price = Math.max(MIN_FARE, miles * PER_MILE);

  res.json({
    fixed: false,
    price_gbp: Number(price.toFixed(2))
  });
});

/* =========================
   BOOK (NO EMAIL YET)
========================= */
app.post("/book", (req, res) => {
  const booking = {
    id: crypto.randomUUID(),
    ...req.body
  };

  res.json({
    success: true,
    booking
  });
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`TTTaxis backend listening on port ${PORT}`);
});
