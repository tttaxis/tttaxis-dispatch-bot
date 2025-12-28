import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import nodemailer from "nodemailer";

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(bodyParser.json());

console.log("SMTP ENV CHECK", {
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  user: process.env.SMTP_USER,
  hasPass: !!process.env.SMTP_PASS
});

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

app.get("/test-email", async (req, res) => {
  try {
    const info = await mailer.sendMail({
      from: `"TTTaxis Test" <${process.env.SMTP_USER}>`,
      to: process.env.SMTP_USER,
      subject: "TTTaxis SMTP Test",
      text: "If you received this email, SMTP is working."
    });

    console.log("EMAIL SENT", info.messageId);

    res.json({ success: true, messageId: info.messageId });
  } catch (err) {
    console.error("EMAIL TEST FAILED", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/quote", (req, res) => {
  res.json({ fixed: false, price_gbp: 10 });
});

app.post("/book", (req, res) => {
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`TTTaxis backend listening on port ${PORT}`);
});
