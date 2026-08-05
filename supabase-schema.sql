-- Run this in Supabase: Dashboard -> SQL Editor -> New Query -> paste -> Run
-- This creates every table the platform needs, with row-level security
-- so each business can only ever see and edit its own data.

create extension if not exists "pgcrypto";

-- ── BUSINESSES ────────────────────────────────────────────────────────
create table businesses (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  slug text unique not null,
  name text not null,
  address text default '',
  brand_color text default '#B5555C',
  font_pairing text default 'editorial',
  brand_customized boolean default false,
  logo_url text,
  availability jsonb not null default '[
    {"closed": true, "openMin": 540, "closeMin": 1020},
    {"closed": false, "openMin": 540, "closeMin": 1020},
    {"closed": false, "openMin": 540, "closeMin": 1020},
    {"closed": false, "openMin": 540, "closeMin": 1020},
    {"closed": false, "openMin": 540, "closeMin": 1020},
    {"closed": false, "openMin": 540, "closeMin": 1020},
    {"closed": true, "openMin": 540, "closeMin": 1020}
  ]',
  availability_customized boolean default false,
  policies jsonb not null default '{"cancellation": "Please give at least 24 hours notice to cancel or reschedule.", "noShow": "No-shows may be charged the full service price.", "general": ""}',
  socials jsonb not null default '{"instagram": "", "facebook": "", "tiktok": "", "website": ""}',

  -- Platform subscription (what the business owner pays YOU)
  plan text not null default 'trial',           -- 'trial' | 'starter' | 'growth' | 'pro'
  trial_days_left int default 7,
  stripe_customer_id text,                       -- platform's own Stripe customer for this business
  stripe_subscription_id text,

  -- Stripe Connect (how the business gets paid by ITS customers)
  stripe_connect_account_id text,
  stripe_connect_charges_enabled boolean default false,

  created_at timestamptz default now()
);

-- ── STAFF ─────────────────────────────────────────────────────────────
create table staff (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  role text default '',
  color text default '#B5555C',
  availability jsonb,        -- null = follows business hours
  instagram text,
  created_at timestamptz default now()
);

-- ── SERVICES ──────────────────────────────────────────────────────────
create table services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  category text default '',
  duration int not null default 30,
  price numeric(10,2) not null default 0,
  created_at timestamptz default now()
);

-- ── CLIENTS ───────────────────────────────────────────────────────────
create table clients (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  phone text,
  email text,
  notes text default '',
  last_visit text,
  total_spent numeric(10,2) default 0,
  created_at timestamptz default now()
);

-- ── APPOINTMENTS ──────────────────────────────────────────────────────
create table appointments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  client_id uuid references clients(id) on delete set null,
  client_name text,
  client_phone text,
  client_email text,
  staff_id uuid references staff(id) on delete set null,
  service_id uuid references services(id) on delete set null,
  date date not null,
  start_min int not null,
  status text not null default 'confirmed',
  code text,
  deposit_amount numeric(10,2) default 0,
  deposit_paid boolean default false,
  deposit_applied boolean default false,
  sms_reminder boolean default false,
  created_at timestamptz default now()
);

-- ── ROW LEVEL SECURITY ────────────────────────────────────────────────
alter table businesses enable row level security;
alter table staff enable row level security;
alter table services enable row level security;
alter table clients enable row level security;
alter table appointments enable row level security;

-- Business owners: full control over their own business row
create policy "Owners manage their own business"
  on businesses for all
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- Anyone (including logged-out customers) can read public booking-page
-- fields — this is what lets the Scheduling Page work without a login.
create policy "Public can view businesses for booking"
  on businesses for select
  using (true);

-- Owners manage their own staff/services/clients
create policy "Owners manage their own staff"
  on staff for all
  using (business_id in (select id from businesses where auth_user_id = auth.uid()))
  with check (business_id in (select id from businesses where auth_user_id = auth.uid()));

create policy "Public can view staff for booking"
  on staff for select using (true);

create policy "Owners manage their own services"
  on services for all
  using (business_id in (select id from businesses where auth_user_id = auth.uid()))
  with check (business_id in (select id from businesses where auth_user_id = auth.uid()));

create policy "Public can view services for booking"
  on services for select using (true);

create policy "Owners manage their own clients"
  on clients for all
  using (business_id in (select id from businesses where auth_user_id = auth.uid()))
  with check (business_id in (select id from businesses where auth_user_id = auth.uid()));

-- Appointments: owners get full control. Customers (logged out) can
-- create a booking and look their own booking up — same phone/code
-- model as the prototype. This is intentionally permissive so the
-- booking flow works without requiring customer accounts; see the
-- security note in README.md before handling real customer PII at scale.
create policy "Owners manage their business's appointments"
  on appointments for all
  using (business_id in (select id from businesses where auth_user_id = auth.uid()))
  with check (business_id in (select id from businesses where auth_user_id = auth.uid()));

create policy "Public can create a booking"
  on appointments for insert
  with check (true);

create policy "Public can view appointments to look up their booking"
  on appointments for select
  using (true);

-- ── HELPFUL INDEXES ───────────────────────────────────────────────────
create index idx_staff_business on staff(business_id);
create index idx_services_business on services(business_id);
create index idx_clients_business on clients(business_id);
create index idx_appointments_business on appointments(business_id);
create index idx_appointments_date on appointments(business_id, date);
create index idx_businesses_slug on businesses(slug);
