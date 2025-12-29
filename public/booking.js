const API = "https://tttaxis-booking-page.up.railway.app";
let BASE_PRICE = null;

document.addEventListener("DOMContentLoaded", () => {

  document.getElementById("getPriceBtn").addEventListener("click", async () => {
    const pickup = pickup.value.trim();
    const dropoff = dropoff.value.trim();

    quote.innerText = "Calculating…";

    const res = await fetch(API + "/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pickup, dropoff })
    });

    const data = await res.json();
    BASE_PRICE = data.price_gbp;

    quote.innerText = `£${(BASE_PRICE * 1.2).toFixed(2)} (inc VAT)`;
  });

  document.getElementById("confirmBtn").addEventListener("click", async () => {
    if (!BASE_PRICE) {
      alert("Please get a price first");
      return;
    }

    const payment_option =
      document.querySelector('input[name="payment_option"]:checked').value;

    const res = await fetch(API + "/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        price_gbp: BASE_PRICE,
        payment_option
      })
    });

    const data = await res.json();

    if (!data.url) {
      alert("Stripe error");
      return;
    }

    window.location.href = data.url;
  });

});
