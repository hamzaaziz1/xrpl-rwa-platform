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
