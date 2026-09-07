# Developer's manual

Reference documentation for `xrpl-rwa-platform`. Written for someone returning
to this after months away — including me.

Updated at each build stage. If something here contradicts the code, the code
is right and this is stale; open an issue.

**Last updated:** stage 5 — deployed.

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

## 5b. The reconciler

`src/recon/reconcile.ts`. Reads live trust line balances from the ledger,
compares them against `holdings`, and records any divergence in
`reconciliation_findings`.

### Why it exists when the projection should already be correct

1. **The projection logic can be wrong.** It was — issuer-side rows were split
   across one row per holder until canonicalization was added. Balances looked
   plausible. Nobody would have noticed.
2. **Events can be missed.** A dropped websocket, a backfill gap, or an account
   added to the registry after transactions already happened against it. The log
   is only complete if ingest never failed.
3. **The ledger is the authority.** Verifying against it is the only real check.
   Everything else is checking the database against itself.

### It checks both directions

| Situation | Means |
|---|---|
| Projection has a balance the ledger doesn't | Projection logic bug |
| Ledger has a balance the projection never recorded | Missed event during ingest |

The second matters more operationally, because it is the failure mode where the
database looks internally consistent and is simply incomplete.

### Issuer comparison

The projection stores the issuer as one canonical row (`-500`). The ledger stores
one trust line per holder (`-400` against Alice, `-100` against Bob). The
reconciler sums the ledger side before comparing.

Comparing naively produces permanent false drift on every run — an alarm that is
always on, which is the same as no alarm.

This is the fourth instance of the two-sided trust line problem. See §8.

### Always reads `validated`

Reading `current` compares against a ledger that has not been finalised,
producing phantom drift that disappears on the next run. That is the worst kind
of alert: intermittent, unreproducible, and trains you to ignore it.

### Severity

| Level | When |
|---|---|
| `info` | Difference under 1e-9. Floating-point noise, not recorded. |
| `warning` | Real but under 1% of the larger value. |
| `critical` | Over 1%, or one side is missing entirely. |

### Drift injection

`src/recon/inject-drift.ts` writes a wrong balance directly into `holdings`,
bypassing the projection. This is the shape of a real bug: the database is
internally consistent and disagrees with the ledger.

```bash
npm run drift                    # corrupt a random holding by +137
npm run drift -- --amount 250    # by a specific amount
npm run reconcile                # detects it as CRITICAL
npm run project -- --rebuild     # repairs it
npm run reconcile                # clean
```

**The repair is not a patch.** It throws away the projection and replays the log.
The corruption cannot survive because it was never in the log — it was written
into a derived table. This is the payoff for keeping `ledger_events` a faithful
record and `holdings` disposable.

A reconciler that has only ever reported "no drift" is untested. The absence of
an alarm proves nothing until you have watched it fire.

---

## 5c. The write path

`src/tx/`. Writes are asynchronous: the API records an intent and returns
immediately; a separate worker moves it through its lifecycle.

### Why not submit-and-wait

Blocking the HTTP request until validation is simpler and would work at this
scale. It was rejected because the interesting problem is the same one the
reconciler solves, in the other direction: **between submitting a transaction
and learning its outcome, you do not know what happened.** If the only record of
the attempt lives in an in-flight HTTP request, that window loses transactions
silently.

Read path: what we believe vs what is true.
Write path: what we meant vs what happened.

### Intent lifecycle

| Status | Meaning |
|---|---|
| `pending` | Recorded, not yet submitted |
| `submitted` | Sent to the ledger, outcome unknown |
| `confirmed` | Validated with `tesSUCCESS` |
| `failed` | Validated with a `tec`/`tem` code — it landed, it failed |
| `expired` | `LastLedgerSequence` passed. **Definitively dead.** |
| `abandoned` | Lost track. Needs a human. |

`submitted` is the state that justifies the design. It is the honest admission
that we have acted and do not yet know the result. Most systems have this window
and simply do not represent it.

### Why `expired` is final

Every transaction carries `LastLedgerSequence`. Once that ledger closes without
validation, the transaction can **never** apply. Not "probably won't" — cannot.
There is no mempool it can resurface from.

That guarantee is what makes retry safe here and hard elsewhere. On a chain with
a mempool, an unconfirmed transaction might land an hour later, so retrying risks
performing the action twice.

### Sequence allocation

Every transaction carries a sequence number for its sending account, used exactly
once, in order.

Reading the account's current sequence from the ledger at submit time breaks
under concurrency: two requests read the same number, one lands, the other fails
with `tefPAST_SEQ`. It works perfectly in testing and fails the moment two things
happen at once.

So sequences come from `account_sequences` under `FOR UPDATE`, which serialises
allocators. The ledger is consulted only to initialise, and to resync.

**`resyncSequence` is not optional.** When a transaction expires or a submission
is rejected, the sequence was never consumed on-ledger, so our counter is ahead.
Every subsequent transaction from that account then fails with `tefPAST_SEQ`
until the counter is pulled back. Without it, the account wedges after the first
expiry.

### The worker submits serially

Allocation is locked, but **submission order matters independently**. The ledger
rejects a transaction whose sequence arrives before its predecessor. Parallel
submission from one account produces `tefPAST_SEQ` under load — a bug that only
appears when two people click at once.

### Failures carry real reasons

When an intent fails, the resolver runs `xrpl-why` against the engine result and
stores the diagnosis. So the UI shows "the issuer requires authorization and has
not authorized this trust line" rather than `tecPATH_DRY`.

Diagnosis is best-effort and wrapped in a try/catch: a failure to explain must
never stop an intent from resolving.

### Running it

```bash
npm run worker           # loop
npm run worker -- --once # one pass, useful for tests
```

The worker is a separate process from the API on purpose. If the API dies
mid-request, the intent survives and the worker picks it up — which is the whole
reason for recording intent before acting.

---

## 5d. The API

`src/api/`. Fastify. Reads in `server.ts`, writes in `writes.ts`.

No authentication. This is a demo with three role views, and building login would
consume a day and demonstrate nothing about tokenization. The role switcher is
client-side and deliberately out of scope.

### Reads

| Endpoint | Returns |
|---|---|
| `GET /api/assets` | Assets with `units_outstanding` and `holder_count` |
| `GET /api/assets/:id/holdings` | Holders joined to investor records |
| `GET /api/investors` | Investors, excluding system accounts |
| `GET /api/reconciliation` | Open findings plus sync watermarks |
| `GET /api/events` | The ledger event log, newest first |
| `GET /api/intents` | Recent intents, for an activity feed |
| `GET /api/intents/:id` | One intent, for polling |

`units_outstanding` is derived by negating the issuer's `holdings` row. It is not
stored anywhere, so it cannot drift from the holder balances independently.

The issuer's own row is excluded from `/holdings` — it is the negative mirror of
every holder, not a holder itself.

### Writes

All return **202 Accepted** with an intent id and a poll URL. Not 200: the
request has been accepted, not completed. Returning 200 would claim an outcome we
do not have.

| Endpoint | Intent kind |
|---|---|
| `POST /api/investors/:id/approve` | `credential_issue` |
| `POST /api/investors/:id/revoke` | `credential_revoke` |
| `POST /api/assets/:id/freeze` | `freeze` |
| `POST /api/assets/:id/unfreeze` | `unfreeze` |
| `POST /api/assets/:id/clawback` | `clawback` |
| `POST /api/assets/:id/issue` | `token_issue` |

Clients poll `GET /api/intents/:id` until `status` leaves `pending`/`submitted`.

A failed intent carries `failure_reason` and `failure_fix` from `xrpl-why`, so
the UI shows "the destination has no trust line for PRP" rather than
`tecPATH_DRY`.

### Running the two processes

```bash
npm run api      # :3001, records intents
npm run worker   # submits and resolves them
```

Separate on purpose. If the API dies mid-request the intent survives, and the
worker picks it up.

---

## 11. Freeze state is projected too

`holdings.frozen` is derived from `TrustSet` transactions carrying `tfSetFreeze`
(`0x00100000`) or `tfClearFreeze` (`0x00200000`). Nothing writes it directly.

**Direction, again:** on a freeze `TrustSet`, the signer is the issuer and
`LimitAmount.issuer` is the **holder being frozen**. Reading it as the token
issuer gets every freeze attributed to the wrong account.

A frozen holder keeps their balance and cannot move it, so a balance check alone
tells you nothing. The register shows a `frozen` badge and offers only the
applicable action — an operator cannot click Freeze on someone already frozen.

This column was added *after* freezes had already happened, and the state was
recovered by replaying the log. Nothing was fetched from the ledger.

---

## 12. Running it

Four processes. None of them require manual intervention once started.

```bash
docker compose up -d      # postgres

npm run ingest            # subscribes to the ledger, projects every 2s
npm run api               # :3001
npm run worker            # drives intents through their lifecycle
cd web && npm run dev     # :5173
```

**`npm run ingest` without `--once` is the normal mode.** It stays subscribed
over a websocket and runs the projection on a timer, so ledger activity — from
this application or from anywhere else — appears in the UI within a couple of
seconds. The `--once` variant backfills and exits, and is for scripted use only.

The frontend polls every two seconds. Nothing needs clicking to refresh.

First run:

```bash
npm run reset && npm run seed
```

---

## 13. Deployment

Live on Railway. Four Railway services:

| Service | Start command | Public |
|---|---|---|
| `Postgres` | managed | no |
| `Api` | `npm run api` | yes, port 3001 |
| `Ingest` | `npm run ingest` | no |
| `Worker` | `npm run worker` | no |

`Ingest` and `Worker` hold long-running connections and expose no HTTP, so they
need no domain. They are separate services on purpose: if the worker crashes,
ingest keeps recording ledger events. Running them in one process means a single
failure takes out both, and "if the API dies the intent survives" stops being
true.

### The frontend is served by the API

Railway's free plan allows four services, and Postgres plus three processes uses
all of them. Rather than pay for a fifth or host the frontend separately, the
root `Dockerfile` builds the frontend in a first stage and copies `dist/` into
the backend image, where `@fastify/static` serves it.

One origin for the app and the API. The client and API can never disagree about
versions, and there is no CORS configuration to get wrong.

`VITE_API_URL` is set to `""` at build time, so the client calls relative paths
against whatever origin served it. **Vite bakes environment variables in at build
time, not runtime** — setting it as a runtime variable has no effect.

The static handler and SPA fallback are registered **after** all API routes.
Registered earlier, the not-found handler would shadow them.

### Environment

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` — a Railway reference, so no password is ever pasted |
| `XRPL_NETWORK` | `testnet` |
| `PORT` | `3001` (API only) |

### First deploy

Schema and seed run from the Railway console on the API service:

```bash
npm run migrate
npm run seed
```

### Known limitation

Testnet accounts do not persist indefinitely, and the seed funds fresh ones each
run. A deployed demo will eventually reference accounts that no longer exist and
need reseeding. This is not automated on purpose — building a data lifecycle for
a demo is effort spent in the wrong place.

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

### Commands

| Command | What it does |
|---|---|
| `npm run migrate` | Apply schema. Idempotent. |
| `npm run reset` | Drop and recreate every table. Destroys data. |
| `npm run seed` | Fund accounts, issue an asset, onboard two investors, trade. |
| `npm run ingest -- --once` | Backfill and exit. Omit `--once` to stay live. |
| `npm run project` | Apply new events to `holdings`. |
| `npm run project -- --rebuild` | Wipe and replay the whole log. |
| `npm run reconcile` | Compare projection against live ledger. |
| `npm run drift` | Deliberately corrupt a holding, for demos. |
| `npm run api` | Read API on :3001. |
| `npm run worker` | Drive intents through their lifecycle. |

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
4. `account_lines` returns one row per trust line, and the `account` field on
   each row is the **counterparty**, not the account queried. So an issuer's
   lines are keyed by holder, and the reconciler has to sum them before comparing
   against the projection's single canonical row.

The projection canonicalizes (3): if the account whose balance changed is itself
a known issuer, `issuer` is rewritten to that account. The rows then collapse
into one, and negating the issuer's balance gives total units outstanding.

Whenever a trust line field looks wrong, ask which side you are reading from
before assuming the data is bad.

**An empty POST body with `content-type: application/json` is a 400.** Fastify's
default parser rejects it before the handler runs, with
`FST_ERR_CTP_EMPTY_JSON_BODY`. Several endpoints legitimately take no body, so
the API registers a parser that treats an empty body as `{}`. The client also
omits the header when there is no body. Either fix alone is sufficient; both are
in place because any client can make this mistake.

**Local request state and ledger state are different things.** A button that
disables on click and re-enables when the POST returns is unguarded: the request
returns in milliseconds, the ledger takes seconds. Buttons must stay disabled
until an intent for that account leaves `pending`/`submitted` in the polled
state, not until the fetch resolves. This caused three separate double-submission
bugs before the pattern was recognised.

**A guard that never matches looks identical to no guard.** `liveFor` searched
intent JSON for an account address, but `GET /api/intents` did not return
`params` — so the address was never in the JSON and the guard silently never
fired. No error, no symptom, just a button that stayed clickable. Same shape as
the reconciler that only checked balances: the check existed and covered less
than it appeared to.

**"The UI has not caught up" and "it did not work" look identical for two
seconds.** Poll interval plus ledger validation means roughly five to ten seconds
between an action and its visible result. Check the database before concluding
something is broken.

**Clawback clamps to the available balance — it does not fail on over-request.**
Asking to claw back 99999 from a holder with 400 units takes 400 and returns
`tesSUCCESS`. Sensible for court-ordered recovery, but it means any UI must show
the holder's current balance next to the amount field. "Claw back 99999" silently
meaning "take everything" is the kind of surprise that surfaces at the worst
possible moment.

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

---

## 10. Credentials are projected, not stored

`investors.kyc_status` used to be a column the API wrote. It could disagree with
the ledger, nothing detected it, and nothing repaired it. Balances were projected
from day one; credentials were not, and that single inconsistency caused every
KYC bug in this project.

Fixed. Credentials are now derived from the event log the same way balances are.

### How it works

`src/ingest/credentials.ts` reads `CredentialCreate`, `CredentialAccept` and
`CredentialDelete` out of `ledger_events` and maintains the `credentials` table.
The API derives `kyc_status` from that table; nothing writes it.

| Derived status | Meaning |
|---|---|
| `pending` | No credential on the ledger |
| `issued` | Credential exists but the subject has **not** accepted it — **not a domain member, cannot trade** |
| `approved` | Issued and accepted |
| `revoked` | Deleted |

`issued` is a real state, not a synonym for approved. Collapsing it loses the
distinction that actually governs eligibility.

### The direction trap, fifth instance

The three credential transactions name the subject differently:

| Transaction | Submitted by | Subject is |
|---|---|---|
| `CredentialCreate` | Issuer | `Subject` |
| `CredentialDelete` | Either party | `Subject`, falling back to `Account` |
| `CredentialAccept` | **Subject** | `Account`, with `Issuer` separate |

Reading `Subject` on an Accept gives `undefined`, and the acceptance silently
attaches to nothing. Same family as `authorized` vs `peer_authorized` — see §8.

### What it caught immediately

On its first run the projection showed Carol's credential as **issued but not
accepted**. The stored column had said `approved` for days. She had never been a
domain member and could not have traded.

The registry had been claiming a state that was never true on the ledger, and
nothing detected it because the reconciler only checked balances.

### The reconciler now checks credentials

Both existence and acceptance state, in both directions:

| Situation | Means |
|---|---|
| Ledger has a credential the projection calls revoked | Missed a `CredentialCreate` |
| Projection has one the ledger doesn't | Missed a `CredentialDelete` |
| Acceptance state disagrees | Missed a `CredentialAccept` — the holder cannot trade |

Verified by deliberately setting `accepted_at` on an unaccepted credential and
watching it flag CRITICAL, then repairing with `npm run project -- --rebuild`.

### No optimistic writes

`POST /api/investors/:id/approve` no longer writes an `approving` status. In-flight
state already lives in `intents`; duplicating it in the registry would be the
registry claiming a state the ledger has not reached.

### Known imperfection

`applyCredential` stamps `issued_at` / `accepted_at` with `now()` — when the event
was *processed*, not when it happened on-ledger. The `_ledger` columns are
accurate. A faithful projection should use the ledger close time, and this should
be fixed.
