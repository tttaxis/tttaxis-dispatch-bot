TTTaxis Dispatch Bot (Backend)
=============================

What this is
------------
A deploy-ready Node.js backend that powers a WordPress-embedded dispatch bot for TTTaxis:
- AI conversation via OpenAI Responses API
- Automatic mileage/time via Google Distance Matrix
- Pricing: minimum fare + mileage, with 1.5x after 23:00
- WhatsApp dispatch notifications via Twilio WhatsApp
- Two-way WhatsApp support (customer replies can update the booking)
- Driver app scaffolding: drivers table + assignment endpoint stub (dispatch now, app later)
- SQLite persistence for bookings/messages/drivers

Quick start (local)
-------------------
1) Install Node.js 18+.
2) In this folder:
   npm install
3) Copy .env.example to .env and fill values.
4) Run:
   npm start
5) Test health:
   GET http://localhost:8787/health

Important endpoints
-------------------
POST /chat                 - Website widget chat endpoint
POST /twilio/whatsapp       - Twilio inbound webhook for WhatsApp messages (two-way)
GET  /admin/bookings        - Simple bookings list (basic auth token via header)
POST /admin/assign-driver   - Assign driver (scaffolding)

Twilio WhatsApp webhook setup
-----------------------------
In Twilio Console, configure your WhatsApp sender (Sandbox or Approved Number) inbound webhook URL:
  {PUBLIC_BASE_URL}/twilio/whatsapp
Method: POST

Security notes
--------------
- Do not put API keys in WordPress.
- Restrict CORS via PUBLIC_ORIGIN.
- Restrict your Google API key to your backend (IP or service account) and enable only required APIs.

