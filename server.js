import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8080;

/* =========================
   MIDDLEWARE
========================= */
app.use(cors({
  origin: ["https://tttaxis.uk", "https://www.tttaxis.uk"],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());
app.options("*", cors());

/* =========================
   QUOTE ROUTE (SAFE BASELINE)
========================= */
app.post("/quote", (req, res) => {
  const { pickup, dropoff } = req.body;

  if (!pickup || !dropoff) {
    return res.status(400).json({ error: "Missing locations" });
  }

  // TEMP: fixed price to prove server stability
  res.json({
    fixed: false,
    price_gbp: 22.00
  });
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`TTTaxis backend listening on port ${PORT}`);
});

