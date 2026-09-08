-- ============================================================
-- append-only log of LEDGER TRANSACTIONS (not balance changes).
-- one row per transaction. never updated, never deleted.
-- tx_hash is the idempotency key.
--
-- balance changes are DERIVED from `raw` at projection time,
-- because a single transaction can move balances for several
-- accounts at once (e.g. a DEX trade touches both sides plus
-- the issuer). keeping the log faithful means the projection
-- logic can change and be replayed without re-fetching.
-- ============================================================
create table if not exists ledger_events (
  tx_hash        text primary key,
  ledger_index   bigint      not null,
  tx_index       int         not null,
  tx_type        text        not null,
  tx_result      text        not null,
  account        text        not null,   -- the submitting account
  raw            jsonb       not null,   -- { tx, meta }
  ingested_at    timestamptz not null default now()
);

create index if not exists ledger_events_order_idx
  on ledger_events (ledger_index, tx_index);

-- ============================================================
-- projection. derived ENTIRELY from ledger_events.
-- safe to truncate and rebuild at any time — that's the test.
--
-- note: the issuer's own balance goes NEGATIVE, which is
-- correct. -1 * issuer balance = total units outstanding.
-- ============================================================
create table if not exists holdings (
  currency           text    not null,
  issuer             text    not null,
  account            text    not null,
  balance            numeric not null default 0,
  last_ledger_index  bigint  not null default 0,
  last_tx_index      int     not null default 0,

  -- projected from TrustSet tfSetFreeze / tfClearFreeze, not written
  -- directly. a frozen holder keeps their balance and cannot move it.
  frozen             boolean not null default false,
  frozen_ledger      bigint,

  primary key (currency, issuer, account)
);

-- ============================================================
-- the legal layer. NOT derived from the ledger.
-- this is why the system exists.
-- ============================================================
create table if not exists assets (
  asset_id       text primary key,
  currency       text not null,
  issuer         text not null,
  title          text not null,
  external_ref   text,
  document_hash  text,
  jurisdiction   text,
  total_units    numeric,
  domain_id      text,          -- permissioned domain gating this asset
  status         text not null default 'active'
);

create table if not exists investors (
  investor_id            text primary key,
  legal_name             text not null,
  email                  text,
  account                text unique,
  seed                   text,          -- testnet only. see MANUAL §6.
  kyc_status             text not null default 'pending',
  kyc_submitted          timestamptz,
  kyc_approved           timestamptz,
  credential_accepted_at timestamptz
);

-- ============================================================
-- watermarks. single row.
-- ingest and projection advance independently.
-- ============================================================
create table if not exists sync_state (
  id                    int primary key default 1,
  last_ingested_ledger  bigint not null default 0,
  last_projected_ledger bigint not null default 0,
  last_projected_tx     int    not null default 0,
  updated_at            timestamptz not null default now(),
  constraint sync_state_singleton check (id = 1)
);

insert into sync_state (id) values (1) on conflict do nothing;

-- ============================================================
-- drift between projection and live ledger state.
-- ============================================================
create table if not exists reconciliation_findings (
  id              bigserial primary key,
  detected_at     timestamptz not null default now(),
  currency        text not null,
  issuer          text not null,
  account         text not null,
  ledger_value    numeric,
  registry_value  numeric,
  severity        text not null,
  resolved_at     timestamptz
);

create index if not exists findings_unresolved_idx
  on reconciliation_findings (detected_at desc)
  where resolved_at is null;

-- ============================================================
-- INTENTS: what we meant to do, recorded before we do it.
--
-- The write-path mirror of the reconciler. An intent is created
-- before submission, updated when the ledger says something, and
-- resolved by a background pass if the process died in between.
--
-- lifecycle:
--
--   pending    created, not yet submitted
--   submitted  sent to the ledger, awaiting validation
--   confirmed  validated with tesSUCCESS
--   failed     validated with a tec/tem code — it landed, it failed
--   expired    LastLedgerSequence passed without validation.
--              DEFINITIVELY dead. XRPL guarantees it can never apply
--              later, which is why this design is tractable at all.
--   abandoned  we lost track of it. needs a human.
-- ============================================================
create table if not exists intents (
  intent_id        uuid primary key default gen_random_uuid(),
  idempotency_key  text unique,        -- client-supplied; safe retries
  kind             text not null,      -- issue | freeze | clawback | credential | ...
  actor            text not null,      -- account that will sign
  params           jsonb not null,     -- everything needed to rebuild the tx
  status           text not null default 'pending',

  -- submission detail
  tx_hash          text,
  account_sequence int,
  last_ledger_seq  int,                -- the expiry deadline
  engine_result    text,
  validated_ledger bigint,

  -- diagnosis when it fails, from xrpl-why
  failure_reason   text,
  failure_fix      text,

  created_at       timestamptz not null default now(),
  submitted_at     timestamptz,
  resolved_at      timestamptz,
  attempts         int not null default 0
);

create index if not exists intents_open_idx
  on intents (created_at desc)
  where status in ('pending', 'submitted');

create index if not exists intents_hash_idx on intents (tx_hash);

-- ============================================================
-- SEQUENCE ALLOCATION.
--
-- Every XRPL transaction from an account carries a sequence number,
-- and they must be used exactly once, in order. Two concurrent
-- requests reading the account's current sequence will both get the
-- same number; one lands and the other fails with tefPAST_SEQ.
--
-- So sequences are allocated here, under a row lock, rather than
-- read from the ledger at submit time.
-- ============================================================
create table if not exists account_sequences (
  account       text primary key,
  next_sequence int not null,
  updated_at    timestamptz not null default now()
);

-- ============================================================
-- CREDENTIALS: projected from ledger events, never written
-- directly.
--
-- This exists because kyc_status was previously a column the
-- application wrote, which meant it could disagree with the ledger
-- and nothing would notice. Balances were projected from day one;
-- credentials were not, and that inconsistency caused every KYC bug
-- in this project.
--
-- Two-sided by protocol design: an issuer creates a credential and
-- the subject must separately accept it. An issued-but-unaccepted
-- credential grants no domain membership, so `accepted_at` is the
-- field that actually matters for eligibility.
-- ============================================================
create table if not exists credentials (
  subject          text not null,
  issuer           text not null,
  credential_type  text not null,   -- hex, as it appears on-ledger

  issued_at        timestamptz,
  issued_ledger    bigint,
  accepted_at      timestamptz,
  accepted_ledger  bigint,
  revoked_at       timestamptz,
  revoked_ledger   bigint,

  primary key (subject, issuer, credential_type)
);

create index if not exists credentials_subject_idx on credentials (subject);

-- ============================================================
-- OFFERS: projected from the ledger, never written directly.
--
-- An OfferCreate that doesn't fully cross leaves an Offer object
-- on the ledger. That is state, so it is derived like everything
-- else.
--
-- The subtlety: an offer can be consumed by SOMEONE ELSE'S
-- transaction. That produces no event from the offer owner's
-- account, so a projection built only from the owner's activity
-- would show offers that no longer exist. The crossing
-- transaction's metadata records the deletion — the projection
-- reads DeletedNode entries for Offer objects, not just
-- transaction types.
-- ============================================================
create table if not exists offers (
  account          text   not null,
  sequence         int    not null,   -- the OfferCreate's sequence; identifies it

  -- what the offer is selling / buying, normalised to the asset
  side             text   not null,   -- 'ask' (selling units) | 'bid' (buying units)
  currency         text   not null,
  issuer           text   not null,
  units            numeric not null,  -- amount of the asset
  xrp_drops        numeric not null,  -- the XRP side, in drops

  domain_id        text,              -- null = open book
  created_ledger   bigint not null,
  closed_ledger    bigint,            -- consumed or cancelled
  closed_reason    text,              -- 'filled' | 'cancelled' | 'unknown'

  primary key (account, sequence)
);

create index if not exists offers_open_idx
  on offers (currency, issuer, side)
  where closed_ledger is null;
