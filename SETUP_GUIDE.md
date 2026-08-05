# DionScheduler Backend — Full Setup & Testing Guide

This is the real money-moving backend. Two completely separate payment
systems live here — don't mix them up:

- **Stripe Connect** = each business's customers pay THAT business
- **Stripe Billing** = each business owner pays YOU, monthly, for the platform

---

## Part 1 — Set up Supabase (the database) — ~15 min

**[YOU DO THIS]**

1. Go to [supabase.com](https://supabase.com) → sign up → **New Project**
2. Pick a name, a strong database password (save it somewhere), and a region close to you
3. Wait ~2 minutes for it to provision
4. Once it's ready: left sidebar → **SQL Editor** → **New query**
5. Open `supabase-schema.sql` from this folder, copy the whole thing, paste it in, click **Run**
6. You should see "Success. No rows returned" — that means all 5 tables + security policies were created
7. Left sidebar → **Table Editor** — confirm you see `businesses`, `staff`, `services`, `clients`, `appointments`

**Get your keys:**
1. Left sidebar → **Project Settings** (gear icon) → **API**
2. Copy the **Project URL** and the **service_role** key (NOT the `anon` key — service_role is different and much more powerful, treat it like a password)

---

## Part 2 — Enable Stripe Connect — ~10 min

**[YOU DO THIS]**

1. Stripe Dashboard (test mode) → left sidebar → **Connect** (or go directly to `dashboard.stripe.com/connect/accounts`)
2. If prompted, choose **"Platform or marketplace"** as your Connect use case
3. Stripe will ask about your platform — for a services-booking platform like this, **Standard accounts** is the right choice (this is what the backend code uses) — <cite index="30-1">Standard gives each connected business full access to their own Stripe Dashboard, which is the right fit for a SaaS platform charging customers directly.</cite>

---

## Part 3 — Create your subscription plans in Stripe — ~10 min

This is what business owners actually pay YOU.

1. Stripe Dashboard → **Product catalog** → **Add product**
2. Create three products:
   - **Starter** — $29/month, recurring
   - **Growth** — $59/month, recurring
   - **Pro** — $99/month, recurring
3. For each one, after saving, click into it and copy the **Price ID** (starts with `price_...`)
4. Save all three Price IDs — they go into `.env` in Part 5

---

## Part 4 — Run the backend locally — ~10 min

```bash
cd platform-backend
npm install
cp .env.example .env
```

Fill in `.env` with:
- Your Stripe **secret key** (`sk_test_...`)
- Your Supabase **Project URL** and **service_role key**
- The three **Price IDs** from Part 3
- Leave the two webhook secrets for Part 5

```bash
npm start
```

You should see `Platform backend running on port 4300`.

---

## Part 5 — Set up both webhooks — ~15 min

Two separate endpoints, two separate secrets — this trips people up, so go slowly.

**For local testing, use the Stripe CLI** (same tool from the earlier payments setup):

```bash
stripe listen --forward-to localhost:4300/webhooks/connect
```
Copy the `whsec_...` it prints into `.env` as `STRIPE_WEBHOOK_SECRET_CONNECT`.

Open a **second terminal** and run the second listener at the same time:
```bash
stripe listen --forward-to localhost:4300/webhooks/billing
```
Copy that `whsec_...` into `.env` as `STRIPE_WEBHOOK_SECRET_BILLING`.

Restart `npm start` after updating `.env` so it picks up both secrets.

**For production**, you'll instead register two real webhook endpoints in
the Dashboard (Developers → Webhooks → Add endpoint) pointing at your
deployed backend's `/webhooks/connect` and `/webhooks/billing` URLs —
each with its own signing secret, same as local, just not using the CLI.

---

## Part 6 — Create a test business row

The backend needs a real business row in Supabase to work against. Quickest way — SQL Editor:

```sql
insert into businesses (slug, name, plan)
values ('test-business', 'Test Business', 'trial')
returning id;
```

Copy the `id` it returns (a UUID) — you'll use it in every test below.

---

## Part 7 — Test Stripe Connect (client payments) — ~10 min

**Start onboarding:**
```bash
curl -X POST http://localhost:4300/connect/onboard \
  -H "Content-Type: application/json" \
  -d '{"businessId": "PASTE_YOUR_BUSINESS_ID_HERE"}'
```

You'll get back `{"url": "https://connect.stripe.com/..."}`. Open that URL
in a browser — it's Stripe's real onboarding flow. In test mode, you can
fill it out with fake test data (Stripe tells you what test values to use
directly on the page — e.g. test SSN `000-00-0000`).

**After finishing onboarding**, confirm it worked:
```bash
curl http://localhost:4300/connect/status/PASTE_YOUR_BUSINESS_ID_HERE
```
Should return `{"connected":true,"chargesEnabled":true}`.

**Now test an actual client payment:**
```bash
curl -X POST http://localhost:4300/client-payment-intent \
  -H "Content-Type: application/json" \
  -d '{"businessId": "PASTE_YOUR_BUSINESS_ID_HERE", "amountCents": 4800}'
```

You should get back a `clientSecret` — same as before, but this time
notice it's tied to the connected account, not your own platform account.
If you check the Stripe Dashboard, switch to viewing that connected
account specifically (Connect → Accounts → click into it) to see this
PaymentIntent show up there, not on your main account.

---

## Part 8 — Test the platform subscription — ~5 min

```bash
curl -X POST http://localhost:4300/subscription/checkout \
  -H "Content-Type: application/json" \
  -d '{"businessId": "PASTE_YOUR_BUSINESS_ID_HERE", "plan": "starter"}'
```

You'll get back `{"url": "https://checkout.stripe.com/..."}`. Open it,
pay with the test card `4242 4242 4242 4242`, any future expiry, any CVC.

After completing checkout, check Supabase → Table Editor → `businesses` —
that row's `plan` column should now say `starter`, and `stripe_subscription_id`
should be filled in. That's the webhook doing its job.

---

## What's NOT done yet — the honest gap

This backend is real and functional, but the **frontend prototype (`platform.jsx`) still runs on in-memory state** — it doesn't call any of this yet. Connecting them means:

1. Replacing every `useState` business/services/staff/clients/appointments
   call in the frontend with real Supabase queries
2. Replacing the plaintext demo login with real Supabase Auth (signup/login)
3. Adding a "Connect Stripe" button in Settings that calls `/connect/onboard`
4. Swapping the simulated deposit/checkout charges for real calls to
   `/client-payment-intent` (same pattern as `StripeCheckout.jsx` from
   the earlier single-business setup, just pointed at this new endpoint
   and passing `businessId` instead of a hardcoded value)
5. Wiring the Billing tab's "Select" buttons to call `/subscription/checkout`

That frontend integration is a substantial next step on its own — happy
to start on it whenever you're ready to keep going.

## Quick checklist

- [ ] Supabase project created, schema run, tables visible
- [ ] Stripe Connect enabled, Standard accounts confirmed
- [ ] 3 subscription products created, Price IDs saved
- [ ] Backend running locally, `.env` fully filled in
- [ ] Both webhooks listening (2 separate `stripe listen` terminals)
- [ ] Test business row created in Supabase
- [ ] Connect onboarding completed for the test business, `chargesEnabled: true`
- [ ] Test client payment intent created successfully
- [ ] Test subscription checkout completed, business's `plan` updated in Supabase
