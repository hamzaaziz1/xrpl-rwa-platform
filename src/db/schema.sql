-- ============================================================
-- append-only record of what happened on the ledger.
-- never updated, never deleted. tx_hash is the idempotency key.
-- ============================================================
create table if not exists ledger_events (
  tx_hash        text primary key,
  ledger_index   bigint      not null,
  tx_index       int         not null,
  tx_type        text        not null,
  tx_result      text        not null,
  account        text        not null,
  destination    text,
  currency       text,
  issuer         text,
  delta          numeric,
  raw            jsonb       not null,
  ingested_at    timestamptz not null default now()
);

create index if not exists ledger_events_order_idx
  on ledger_events (ledger_index, tx_index);

-- ============================================================
-- projection. derived ENTIRELY from ledger_events.
-- safe to drop and rebuild at any time — that's the test.
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
  kyc_status             text not null default 'pending',
  kyc_submitted          timestamptz,
  kyc_approved           timestamptz,
  credential_accepted_at timestamptz
);

-- ============================================================
-- how far ingest and projection have processed. single row.
-- ============================================================
create table if not exists sync_state (
  id                    int primary key default 1,
  last_ingested_ledger  bigint not null default 0,
  last_projected_ledger bigint not null default 0,
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
