// Platform backend — the real money-moving piece.
//
// Two completely separate payment flows live here:
//
//   1. STRIPE CONNECT — lets each business connect their own Stripe
//      account, so when THEIR customer pays a deposit or checks out,
//      the money lands in the BUSINESS's bank account, not yours.
//
//   2. STRIPE BILLING — completely separate — this is how the
//      business owner pays YOU a monthly subscription to use the
//      platform (Starter/Growth/Pro).
//
// Both need real business records to attach to, which is why this
// also talks to Supabase (a real database) instead of in-memory state.

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { createClient } = require("@supabase/supabase-js");

// Service role key — full access, bypasses row-level security. This
// must ONLY ever live on this server, never in any frontend code.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PLAN_PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_STARTER,
  growth: process.env.STRIPE_PRICE_GROWTH,
  pro: process.env.STRIPE_PRICE_PRO,
};

const app = express();
app.use(cors());

// ── WEBHOOKS ──────────────────────────────────────────────────────────
// Registered before express.json() — Stripe webhook signature
// verification needs the raw, unparsed request body.

// Fires when a connected business's account status changes — e.g. once
// they finish onboarding and can actually accept payments.
app.post("/webhooks/connect", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET_CONNECT);
  } catch (err) {
    console.error("Connect webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "account.updated") {
    const account = event.data.object;
    await supabase
      .from("businesses")
      .update({ stripe_connect_charges_enabled: !!account.charges_enabled })
      .eq("stripe_connect_account_id", account.id);
    console.log(`Connect account ${account.id} charges_enabled = ${account.charges_enabled}`);
  }

  res.json({ received: true });
});

// Fires on subscription lifecycle events — this is how a business's
// `plan` field actually gets updated after they pay you.
app.post("/webhooks/billing", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET_BILLING);
  } catch (err) {
    console.error("Billing webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const businessId = session.metadata?.businessId;
      const plan = session.metadata?.plan;
      if (businessId) {
        await supabase
          .from("businesses")
          .update({ plan, stripe_customer_id: session.customer, stripe_subscription_id: session.subscription })
          .eq("id", businessId);
        console.log(`Business ${businessId} subscribed to ${plan}`);
      }
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      await supabase
        .from("businesses")
        .update({ plan: "trial", trial_days_left: 0 })
        .eq("stripe_subscription_id", sub.id);
      console.log(`Subscription ${sub.id} cancelled — business reverted to trial`);
      break;
    }
    default:
      break;
  }

  res.json({ received: true });
});

app.use(express.json());

// ── STRIPE CONNECT: onboarding ───────────────────────────────────────
// Call this when a business owner clicks "Connect Stripe" in Settings.
app.post("/connect/onboard", async (req, res) => {
  try {
    const { businessId } = req.body;
    const { data: business, error } = await supabase.from("businesses").select("*").eq("id", businessId).single();
    if (error || !business) return res.status(404).json({ error: "Business not found" });

    let accountId = business.stripe_connect_account_id;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "standard",
        email: undefined, // let the business owner enter their own email during onboarding
        metadata: { businessId },
      });
      accountId = account.id;
      await supabase.from("businesses").update({ stripe_connect_account_id: accountId }).eq("id", businessId);
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${process.env.PLATFORM_URL}/connect/refresh?business=${businessId}`,
      return_url: `${process.env.PLATFORM_URL}/connect/complete?business=${businessId}`,
      type: "account_onboarding",
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Check onboarding status directly (in addition to the webhook) —
// useful right after the owner returns from Stripe's onboarding flow.
app.get("/connect/status/:businessId", async (req, res) => {
  try {
    const { data: business } = await supabase.from("businesses").select("stripe_connect_account_id").eq("id", req.params.businessId).single();
    if (!business?.stripe_connect_account_id) return res.json({ connected: false, chargesEnabled: false });

    const account = await stripe.accounts.retrieve(business.stripe_connect_account_id);
    await supabase.from("businesses").update({ stripe_connect_charges_enabled: !!account.charges_enabled }).eq("id", req.params.businessId);

    res.json({ connected: true, chargesEnabled: !!account.charges_enabled });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── CLIENT PAYMENTS (deposits, checkout) — money goes to the BUSINESS ──
app.post("/client-payment-intent", async (req, res) => {
  try {
    const { businessId, amountCents, metadata = {} } = req.body;
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: "amountCents must be a positive integer" });
    }

    const { data: business, error } = await supabase.from("businesses").select("stripe_connect_account_id, stripe_connect_charges_enabled").eq("id", businessId).single();
    if (error || !business) return res.status(404).json({ error: "Business not found" });
    if (!business.stripe_connect_account_id || !business.stripe_connect_charges_enabled) {
      return res.status(400).json({ error: "This business hasn't finished connecting their Stripe account yet." });
    }

    // The { stripeAccount } option is what makes this a "direct charge" —
    // the connected business is the merchant of record, and the money
    // (minus Stripe's own fees) lands directly in their bank account.
    const paymentIntent = await stripe.paymentIntents.create(
      { amount: amountCents, currency: "usd", automatic_payment_methods: { enabled: true }, metadata },
      { stripeAccount: business.stripe_connect_account_id }
    );

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/client-refund", async (req, res) => {
  try {
    const { businessId, paymentIntentId } = req.body;
    const { data: business } = await supabase.from("businesses").select("stripe_connect_account_id").eq("id", businessId).single();
    if (!business?.stripe_connect_account_id) return res.status(404).json({ error: "Business not found" });

    const refund = await stripe.refunds.create({ payment_intent: paymentIntentId }, { stripeAccount: business.stripe_connect_account_id });
    res.json(refund);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── PLATFORM SUBSCRIPTION (Stripe Billing) — money goes to YOU ────────
app.post("/subscription/checkout", async (req, res) => {
  try {
    const { businessId, plan } = req.body;
    const priceId = PLAN_PRICE_IDS[plan];
    if (!priceId) return res.status(400).json({ error: "Unknown plan" });

    const { data: business, error } = await supabase.from("businesses").select("*").eq("id", businessId).single();
    if (error || !business) return res.status(404).json({ error: "Business not found" });

    let customerId = business.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ metadata: { businessId } });
      customerId = customer.id;
      await supabase.from("businesses").update({ stripe_customer_id: customerId }).eq("id", businessId);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.PLATFORM_URL}/billing/success?business=${businessId}`,
      cancel_url: `${process.env.PLATFORM_URL}/billing/cancelled?business=${businessId}`,
      metadata: { businessId, plan },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Lets a business owner manage/cancel their own subscription without
// you building a custom UI for it — Stripe hosts this page.
app.post("/subscription/portal", async (req, res) => {
  try {
    const { businessId } = req.body;
    const { data: business } = await supabase.from("businesses").select("stripe_customer_id").eq("id", businessId).single();
    if (!business?.stripe_customer_id) return res.status(400).json({ error: "No subscription on file yet" });

    const session = await stripe.billingPortal.sessions.create({
      customer: business.stripe_customer_id,
      return_url: `${process.env.PLATFORM_URL}/billing`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4300;
app.listen(PORT, () => console.log(`Platform backend running on port ${PORT}`));
