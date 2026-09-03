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
