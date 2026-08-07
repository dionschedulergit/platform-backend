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

// Railway sits in front of this app as a reverse proxy — without this,
// every request looks like it comes from Railway's own internal IP,
// which would break both the rate limiter below and any per-IP logic.
app.set("trust proxy", true);

// Only the real frontend (and local dev) can call this API from a
// browser. This doesn't stop a direct curl/script request (nothing
// server-side truly can), but it closes off the easiest attack — some
// other website silently firing requests at this API from a visitor's
// browser — and it's free to add.
const ALLOWED_ORIGINS = [
  process.env.PLATFORM_URL || "https://dionscheduler.com",
  "http://localhost:5173",
  "http://localhost:3000",
];
app.use(cors({ origin: ALLOWED_ORIGINS }));

// ── WEBHOOKS ──────────────────────────────────────────────────────────
// Registered before express.json() and before the rate limiter — Stripe
// webhook signature verification needs the raw, unparsed request body,
// and Stripe's own retry bursts shouldn't get throttled.

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

// ── LIGHTWEIGHT RATE LIMITING ───────────────────────────────────────
// A simple in-memory, per-IP sliding window — no extra dependency to
// install, no extra infrastructure to run. It won't stop a determined,
// distributed attacker, but it blunts casual brute-forcing and spam
// against a single Railway instance. (If this backend ever runs on
// multiple instances at once, swap this for a shared store like Redis
// — an in-memory counter only sees traffic that hits that one instance.)
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60; // requests per IP per minute
const rateLimitHits = new Map(); // ip -> [timestamps]

function rateLimit(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const hits = (rateLimitHits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateLimitHits.set(ip, hits);
  if (hits.length > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Too many requests — please slow down and try again shortly." });
  }
  next();
}
// Keep the map from growing forever with IPs that stopped sending requests.
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of rateLimitHits) {
    const fresh = hits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) rateLimitHits.delete(ip);
    else rateLimitHits.set(ip, fresh);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

app.use(rateLimit);

// ── AUTH: verify the caller actually owns this business ────────────────
// businessId is NOT a secret — it's visible in the browser on every
// business's public booking page (/book/:slug), so "the request includes
// a valid businessId" proves nothing on its own. Every endpoint that can
// view/change a business's Stripe Connect account, issue a refund, or
// touch their platform subscription requires the caller to send a real,
// currently-valid Supabase login session for THAT business's owner —
// verified here against Supabase's own auth server, not just decoded.
async function getVerifiedBusiness(req, res, businessId) {
  if (!businessId) {
    res.status(400).json({ error: "businessId is required" });
    return null;
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "You must be logged in to do this." });
    return null;
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    res.status(401).json({ error: "Your session has expired — please log in again." });
    return null;
  }

  const { data: business, error: bizError } = await supabase.from("businesses").select("*").eq("id", businessId).single();
  if (bizError || !business) {
    res.status(404).json({ error: "Business not found" });
    return null;
  }

  if (business.auth_user_id !== user.id) {
    res.status(403).json({ error: "You don't have permission to manage this business." });
    return null;
  }

  return business;
}

// ── STRIPE CONNECT: onboarding ───────────────────────────────────────
// Call this when a business owner clicks "Connect Stripe" in Settings.
// Owner-only — requires a valid login session for this business.
app.post("/connect/onboard", async (req, res) => {
  try {
    const { businessId } = req.body;
    const business = await getVerifiedBusiness(req, res, businessId);
    if (!business) return;

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
// Owner-only — requires a valid login session for this business.
app.get("/connect/status/:businessId", async (req, res) => {
  try {
    const business = await getVerifiedBusiness(req, res, req.params.businessId);
    if (!business) return;
    if (!business.stripe_connect_account_id) return res.json({ connected: false, chargesEnabled: false });

    const account = await stripe.accounts.retrieve(business.stripe_connect_account_id);
    await supabase.from("businesses").update({ stripe_connect_charges_enabled: !!account.charges_enabled }).eq("id", business.id);

    res.json({ connected: true, chargesEnabled: !!account.charges_enabled });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── CLIENT PAYMENTS (deposits, checkout) — money goes to the BUSINESS ──
// Deliberately left open, no login required — customers booking a
// deposit are never logged in. This only ever creates a Stripe
// PaymentIntent (nothing is charged until a real card is entered and
// confirmed with Stripe directly), so the worst case of someone abusing
// this endpoint on its own is unused PaymentIntents cluttering a
// business's Stripe dashboard — the rate limiter above keeps that cheap
// to ignore.
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

// Issuing a refund undoes a real charge — this is a business decision,
// not something a customer should be able to trigger on themselves.
// Owner-only — requires a valid login session for this business.
app.post("/client-refund", async (req, res) => {
  try {
    const { businessId, paymentIntentId } = req.body;
    const business = await getVerifiedBusiness(req, res, businessId);
    if (!business) return;
    if (!business.stripe_connect_account_id) return res.status(404).json({ error: "Business not found" });

    const refund = await stripe.refunds.create({ payment_intent: paymentIntentId }, { stripeAccount: business.stripe_connect_account_id });
    res.json(refund);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── PLATFORM SUBSCRIPTION (Stripe Billing) — money goes to YOU ────────
// Owner-only — requires a valid login session for this business.
app.post("/subscription/checkout", async (req, res) => {
  try {
    const { businessId, plan } = req.body;
    const priceId = PLAN_PRICE_IDS[plan];
    if (!priceId) return res.status(400).json({ error: "Unknown plan" });

    const business = await getVerifiedBusiness(req, res, businessId);
    if (!business) return;

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
// you building a custom UI for it — Stripe hosts this page. This is the
// single most sensitive endpoint in this file (a working link straight
// into a business's real billing portal), so it's owner-only — requires
// a valid login session for this business.
app.post("/subscription/portal", async (req, res) => {
  try {
    const { businessId } = req.body;
    const business = await getVerifiedBusiness(req, res, businessId);
    if (!business) return;
    if (!business.stripe_customer_id) return res.status(400).json({ error: "No subscription on file yet" });

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
