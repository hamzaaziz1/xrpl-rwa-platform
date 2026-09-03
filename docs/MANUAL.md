# Developer's manual

Reference documentation for `xrpl-rwa-platform`. Written for someone returning
to this after months away — including me.

Updated at each build stage. If something here contradicts the code, the code
is right and this is stale; open an issue.

**Last updated:** stage 1 complete (schema, ingest, projection)

---

## 1. What this is

A demonstration of regulated real-world asset tokenization on the XRP Ledger.
A property is tokenized as a fungible token; investors are onboarded through
KYC, issued on-chain credentials, admitted to a permissioned domain, and trade
fractions among themselves. A regulator can observe everything and intervene.

Off-chain, a registry mirrors ownership and is continuously verified against the
ledger.

The architecture mirrors what production RWA platforms actually do — the
interesting problem is not minting a token, it is keeping a legal system of
record and a distributed ledger in agreement, forever, without either drifting.

### Scope boundaries

- **Testnet only.** Nothing here should ever touch mainnet.
- **Custodial by design.** The backend holds investor keys. See §6.
- **KYC is simulated.** A form and a human approval step, no real verification.

---

## 2. Why the ledger primitives are what they are

Decisions made before any code, based on what is actually live on the network.
Re-verify with `npm run amendments` in the `xrpl-rwa-cookbook` repo if returning
to this after a long gap — amendments activate over time and this may be stale.

### The asset is a trust line token, not an MPT

Multi-Purpose Tokens are the newer and richer standard, with native metadata and
cleaner compliance flags. They cannot be traded on the DEX. That requires
`MPTokensV2` (XLS-82), which was still in development as of September 2026.

Since a permissioned secondary market is the whole point, the asset is a
classic trust line token. If `MPTokensV2` activates, this decision should be
revisited.

### Settlement is not atomic

Atomic delivery-versus-payment would use `Batch` to bundle the buyer's payment
and the seller's delivery so that both happen or neither does. `Batch` was
disabled after a signature-validation flaw and replaced by `BatchV1_1`, which as
of writing was live on **devnet but not testnet**.

So settlement here relies on the DEX's own matching, which is atomic within a
single `OfferCreate` crossing. Cross-asset DvP is out of scope.

### Access control is a permissioned domain, not an allowlist

A domain declares which credentials it accepts. An account is a member if it
currently holds an accepted credential. **There is no member list** — membership
is derived, not stored.

Consequence: revoking a credential removes access immediately, everywhere,
without any transaction touching the domain and with nothing to synchronise.
This is the single strongest argument for building this on XRPL rather than an
EVM chain, where the equivalent is an array you maintain and every consuming
contract needs its own copy or a registry call.

### Issuer flags, set before any issuance

| Flag | Why |
|---|---|
| `asfRequireAuth` (2) | The compliance allowlist. No holder without approval. |
| `asfAllowTrustLineClawback` (16) | Recovery under court order or sanctions. |
| `asfDefaultRipple` (8) | Without it, holder-to-holder transfers fail entirely. |

**`AllowTrustLineClawback` cannot be enabled once any trust line exists.** Set it
on a virgin issuer account before anything else, or start over. Attempting it
later returns `tecOWNERS`.

---

## 3. Architecture

```
   XRP Ledger (testnet)
          │
          │  websocket subscription + account_tx backfill
          ▼
   ┌─────────────┐
   │   ingest    │   append-only, idempotent on tx_hash
   └─────────────┘
          │
          ▼
   ┌─────────────┐
   │ ledger_     │   the log. never updated, never deleted.
   │ events      │
   └─────────────┘
          │
          │  applied in (ledger_index, tx_index) order
          ▼
   ┌─────────────┐
   │  holdings   │   projection. disposable. rebuildable.
   └─────────────┘
          │
          │  compared against live ledger state
          ▼
   ┌─────────────┐
   │ reconciler  │──▶ reconciliation_findings
   └─────────────┘

   ┌─────────────┐
   │  registry   │   assets, investors. NOT derived from the ledger.
   └─────────────┘   this is why the system exists.
```

### The governing rule

**The ledger is the source of truth for ownership. The registry is a projection
of it, plus the legal and identity data that cannot live on-chain.**

Everything follows from that:

- Never write a transfer to the registry and then submit it. Submit, wait for
  validation, and let the registry learn about it through ingest.
- The application is **not the only writer**. A holder can trade directly from a
  wallet. If the registry only knows about transfers that went through the UI, it
  is wrong the first time anyone bypasses it — and will never notice.
- Therefore ingest is ledger-driven, not application-driven.

---

## 4. Schema reference

Defined in `src/db/schema.sql`. Applied with `npm run migrate` (idempotent —
every statement is `if not exists`).

### `ledger_events`

Append-only log of ledger activity. Never updated, never deleted.

| Column | Notes |
|---|---|
| `tx_hash` | Primary key. **This is the idempotency mechanism.** Insert with `ON CONFLICT DO NOTHING` and re-ingestion becomes a no-op. |
| `ledger_index`, `tx_index` | Together give total ordering. Always process by this pair, never by `ingested_at`. |
| `tx_result` | Engine result. **Failed transactions still land in ledgers** — the projection must skip anything that isn't `tesSUCCESS`. |
| `raw` | Full transaction JSON. Kept so the projection can be changed and replayed without re-fetching from the ledger. |

### `holdings`

The projection. Current balance per `(currency, issuer, account)`.

**This table is disposable.** It contains nothing the ledger doesn't already
know. If it is ever wrong, truncate it and replay from `ledger_events`. That
property is what makes the determinism test possible and the reconciler
meaningful.

`last_ledger_index` / `last_tx_index` record which event was last applied to
each row, so partial replays can be detected.

### `assets`, `investors`

The registry. **Not derived from the ledger** — this is the legal layer, and the
reason an off-chain database exists at all.

`investors` carries three separate KYC timestamps rather than a single status:

| Column | Meaning |
|---|---|
| `kyc_submitted` | Investor provided documents |
| `kyc_approved` | Issuer approved; credential created on-ledger |
| `credential_accepted_at` | Investor accepted the credential |

These are three genuinely distinct states because **XRPL credentials are
two-sided**: an issuer creates one, and the subject must separately accept it.
An approved-but-unaccepted investor is not a domain member and cannot trade.
Collapsing this into a boolean produces a UI that shows approved users as
rejected.

### `sync_state`

Single row (enforced by a check constraint). Two watermarks:

- `last_ingested_ledger` — how far ingest has read
- `last_projected_ledger` — how far the projection has applied

They are separate because ingest and projection advance independently.

### `reconciliation_findings`

Drift detected between the projection and live ledger state. Append-only;
resolution is recorded by setting `resolved_at` rather than deleting.

---

## 5. Ingest and projection

Three files in `src/ingest/`.

### `normalize.ts`

XRPL returns transactions in two different shapes depending on API version
and endpoint — `transaction` in v1, `tx_json` in v2, and `account_tx` wraps
each entry differently again. Everything is normalized at the boundary rather
than guessed at downstream.

It returns `null` for anything ambiguous instead of guessing. A silently
misparsed transaction is a missing balance change nobody ever notices.

### `ingest.ts`

Writes every transaction touching a watched account into `ledger_events`.
Watched accounts are the issuer plus every investor — watching only the issuer
would miss holder-to-holder DEX trades, which are exactly what the reconciler
exists to catch.

Idempotency comes from `INSERT ... ON CONFLICT (tx_hash) DO NOTHING`. Accounts
share transactions, so duplicates are normal and expected during backfill.

### `project.ts`

Applies events to `holdings` in `(ledger_index, tx_index)` order. The watermark
advances in the **same database transaction** as the balance updates, so a crash
mid-batch resumes from a consistent point.

Two non-obvious things:

**Balance changes come from METADATA, not from the transaction.** A Payment's
`Amount` is what was *requested*; the metadata records what actually moved.
They differ on partial payments and on any path carrying a transfer fee.
`getBalanceChanges` from xrpl.js does the metadata walk and gets the sign
convention right.

**`getBalanceChanges` reports each trust line from both sides, and the `issuer`
field means different things on each.** See §8.

`rebuild()` truncates `holdings`, resets the watermark, and replays the entire
log. This is not just a recovery tool — it is the property the whole design
rests on. If replaying produces different state, the projection is not a pure
function of the log and cannot be trusted.

It has already earned its keep once: the issuer-canonicalization fix changed how
balances are computed, and applying it needed nothing more than a replay. No
re-fetching from the ledger.

### Startup ordering (important)

Do this in exactly this order or you will have a gap:

1. Open the websocket subscription and **buffer** incoming events in memory
2. Read `sync_state.last_ingested_ledger`
3. Backfill with `account_tx` from that ledger onward, paging through markers
4. Drain the buffer, discarding anything already ingested
5. Go live

Subscribing *after* backfilling leaves a hole between the last backfilled ledger
and the first streamed one. It is a small window and it will be missed in
testing.

### No reorg handling, deliberately

Once a ledger is validated on XRPL it is final. There are no reorganisations.

So unlike an Ethereum indexer, this has no confirmation depth, no reorg
detection, and no unwinding of applied blocks. If you are reading this having
worked on EVM indexers and wondering where that code is: it isn't needed.

---

## 6. Custody

The backend holds investor private keys and signs on their behalf.

This is a deliberate choice, matching how production RWA platforms actually
operate — institutions will not ask retail investors to manage seed phrases, and
regulated custody is typically a licensed service.

**What this demo does:** stores testnet seeds in the database.

**What production would require, and this does not do:** an HSM or a licensed
custody provider, key material never touching application memory, per-key access
audit logging, and a signing service isolated from the API. None of that is here.
It is a testnet demonstration and the keys control nothing of value.

---

## 7. Running it

```bash
docker compose up -d      # postgres on :5432
npm install
npm run migrate           # apply schema, idempotent
```

Environment (`.env`, gitignored):

```
DATABASE_URL=postgresql://rwa:rwa@localhost:5432/rwa
XRPL_NETWORK=testnet
```

### Useful

```bash
docker compose ps                              # is the db up
docker compose exec db psql -U rwa -d rwa      # sql shell
docker compose down -v                         # DESTROYS the volume
```

---

## 8. Gotchas

Collected as they are encountered. Each of these cost real time.

**Trust lines are two-sided, and every field on them has a direction.** This has
now caused three separate bugs, and they are all the same bug:

1. `authorized` on `account_lines` means *this account authorized the
   counterparty*. Querying a holder, the field you want is `peer_authorized`.
2. A freeze can be on the sender's line or the destination's. Checking only one
   gives a confident wrong answer.
3. `getBalanceChanges` emits a row per side. On a holder's row, `issuer` is the
   token issuer. On the issuer's own row, `issuer` is the **counterparty** — so
   the issuer's position splits into one row per holder and the column means two
   different things depending on which row you read.

The projection canonicalizes (3): if the account whose balance changed is itself
a known issuer, `issuer` is rewritten to that account. The rows then collapse
into one, and negating the issuer's balance gives total units outstanding.

Whenever a trust line field looks wrong, ask which side you are reading from
before assuming the data is bad.

**`tecPATH_DRY` means five different things.** No trust line, unauthorized line,
frozen line (either side), global freeze, or `DefaultRipple` disabled. See the
[write-up](https://hamzaaziz.hashnode.dev/tecpath-dry-means-five-different-things).
Insufficient balance is a *different* code, `tecPATH_PARTIAL`.

**Trust line fields have a direction.** On `account_lines` for a holder,
`authorized` means the holder authorized the issuer. The field you almost always
want is `peer_authorized`.

**Flag numbers differ between setting and reading.** `AccountSet` takes an index
(2, 8, 16); the ledger stores a bit position (`0x00040000`, `0x00800000`,
`0x80000000`). Two numbering schemes for the same thing.

**Scripts that assume a clean starting state fail confusingly.** Either create
everything you need, or read what exists and adapt. A script that assumes and
does not check will one day print confident labels over completely wrong state
without erroring.

**Testnet accounts do not persist indefinitely.** Testnet resets periodically.
Any hardcoded address will eventually stop existing.

---

## 9. Related repositories

- **[xrpl-rwa-cookbook](https://github.com/hamzaaziz1/xrpl-rwa-cookbook)** —
  standalone runnable scripts for each ledger primitive used here. Start there
  to understand any single mechanism in isolation.
- **[xrpl-why](https://github.com/hamzaaziz1/xrpl-why)** — diagnoses failed
  XRPL transactions by inspecting ledger state. Used in this platform so UI
  errors give real reasons instead of `tec` codes.
