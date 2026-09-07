# xrpl-rwa-platform

Regulated real-world asset tokenization on the XRP Ledger. A property is
tokenized, investors are onboarded through KYC and admitted to a permissioned
domain, they trade fractions among themselves, and a regulator can observe
everything and intervene.

**[Live demo →](https://api-production-08ffa.up.railway.app)** — XRPL testnet, no
login, three role views in the top nav.

Minting a token is a tutorial. The problem this is actually about is keeping a
legal system of record and a distributed ledger in agreement, forever, without
either one drifting — and knowing when they do.

---

## What it does

| View | |
|---|---|
| **Issuer** | Approve KYC, issue units, freeze a holder, claw back |
| **Investor** | Hold a position, accept your own credential, see why you can or can't trade |
| **Regulator** | Reconciliation status, register, failed operations with diagnoses, audit trail |

Every action is a real transaction on XRPL testnet. Every hash in the UI links
to `testnet.xrpl.org`, so nothing has to be taken on trust.

---

## The three claims

### 1. Every piece of ledger-derived state is projected, not stored

`ledger_events` is an append-only log of transactions, keyed on transaction
hash. `holdings`, `credentials`, and freeze state are all derived from it.
Nothing writes them directly.

Which means they are **disposable**. If any of them is ever wrong:

```bash
npm run project -- --rebuild
```

Truncate, replay the log, done. No migration, no repair script, no reconciling
old and new.

This paid for itself four times. Adding issuer-row canonicalization, adding the
credentials table, adding freeze tracking — each was a change to how history is
interpreted, applied by replaying data that was already in the database. The
freeze column did not exist when the first holder was frozen; it was added,
the log replayed, and the state was simply there.

### 2. The reconciler assumes the projection is wrong

It reads live state from the ledger and compares it against the projection, in
both directions:

| Situation | Means |
|---|---|
| Projection has a balance the ledger doesn't | Projection logic is wrong |
| Ledger has one the projection never recorded | An event was missed during ingest |

The second is the failure that matters operationally — the database looks
internally consistent and is simply incomplete.

There is a deliberate drift injector, because an alarm nobody has watched fire
is untested:

```bash
npm run drift                  # write a wrong balance straight into holdings
npm run reconcile              # detected as CRITICAL
npm run project -- --rebuild   # replay the log
npm run reconcile              # clean
```

The repair is not a patch. The corruption cannot survive a replay because it was
never in the log.

### 3. Writes are asynchronous, with an intent recorded before the action

The API records an intent and returns `202` immediately. A separate worker
submits it, and a resolver asks the ledger what happened.

```
pending → submitted → confirmed | failed | expired
```

`submitted` is the state that justifies the design. It is the honest admission
that a transaction has been sent and the outcome is not yet known. Most systems
have that window and simply don't represent it.

`expired` is final, and that's an XRPL property being exploited: every
transaction carries `LastLedgerSequence`, and once that ledger closes without
validation the transaction can **never** apply. There is no mempool it can
resurface from, so retrying is safe. On a chain with a mempool this is
considerably harder.

Failures carry real reasons rather than engine codes, via
[`xrpl-why`](https://github.com/hamzaaziz1/xrpl-why):

> `tecPATH_DRY` → "The destination has no trust line for PRP from rBx1… The
> destination must submit a TrustSet transaction to opt in."

---

## Design decisions

**Trust line token, not an MPT.** Multi-Purpose Tokens are the richer standard,
but MPT trading on the DEX requires `MPTokensV2` (XLS-82), which was still in
development. A permissioned secondary market is the point, so the asset is a
classic trust line token.

**Settlement is not atomic, and the README says so.** Atomic
delivery-versus-payment would use `Batch`, which was disabled after a
signature-validation flaw and replaced by `BatchV1_1` — live on devnet, not
testnet.

**Access control is a permissioned domain, not an allowlist.** A domain declares
which credentials it accepts; membership is *derived* from what an account
currently holds. There is no member list. Revoking a credential removes access
immediately, everywhere, with no transaction touching the domain and nothing to
synchronise. On EVM the equivalent is an array you maintain and every consuming
contract needs its own copy.

**Custodial keys.** The backend signs on behalf of investors, which is what
production RWA platforms actually do — institutions will not ask retail users to
manage seed phrases. This demo stores testnet seeds in the database. Production
would require an HSM or a licensed custody provider, key material never touching
application memory, and a signing service isolated from the API. None of that is
here, and the keys control nothing.

**No authentication.** Three role views with a switcher. Building login would
consume a day and demonstrate nothing about tokenization.

**Three processes, not one.** API, ingest, and worker run separately. If the
worker crashes, ingest keeps recording ledger events. Merging them to save
resources would quietly undo the sentence that justifies the intents table:
*if the API dies mid-request, the intent survives.*

---

## Things that went wrong

Kept because they're the actual content. The full account is in
[`docs/build-log.md`](docs/build-log.md).

**`tecPATH_DRY` means five different things.** No trust line, unauthorized line,
frozen line (either side), global freeze, or rippling disabled. Insufficient
balance is a *different* code. I published the wrong count before tests against
the live network corrected me — [write-up
here](https://hamzaaziz.hashnode.dev/tecpath-dry-means-five-different-things).

**Trust lines are two-sided, and every field has a direction.** Six instances of
the same bug before I stopped treating them as separate gotchas:
`authorized` vs `peer_authorized`; freeze on the sender vs the destination;
`issuer` meaning counterparty on the issuer's own balance row; `account_lines`
rows keyed by the other party; `CredentialAccept` naming the subject as
`Account`; `LimitAmount.issuer` naming the holder on a freeze. A trust line is a
relationship, not a possession.

**KYC status was stored while balances were projected.** The one place the
pattern wasn't applied, and it caused every KYC bug in the project. When the
credential projection was finally built, its first run revealed an investor who
had been marked `approved` for two days while holding an unaccepted credential —
she had never been a domain member and could not have traded. The registry was
claiming a state that was never true, and nothing detected it because the
reconciler only checked balances.

**A guard that never matches looks identical to no guard.** Buttons that were
supposed to lock during submission searched intent JSON for an account address,
but the API didn't return the field containing it. No error, no symptom, just
buttons that stayed clickable. Same shape as the reconciler covering less than it
appeared to.

**Clawback clamps rather than failing.** Asking to claw back 99,999 units from a
holder with 400 takes 400 and returns success. Reasonable for a court-ordered
recovery; alarming in a UI. The confirmation now shows the holder's balance and
says so.

**A script printed confident labels over completely wrong state.** Re-running the
issuance script against leftover data produced output claiming "line open, not
authorized" above a balance of 250 and a status of authorized. It didn't error.
That failure — well-formatted, plausible, wrong — is the one I'm most careful
about now.

---

## Running it

```bash
docker compose up -d          # postgres
npm install
npm run reset && npm run seed # fund testnet accounts, issue, trade
```

Then four processes:

```bash
npm run ingest    # subscribes to the ledger, projects every 2s
npm run api       # :3001, serves the API and the frontend
npm run worker    # drives intents through their lifecycle
cd web && npm run dev
```

`npm run ingest` **without** `--once` is the normal mode — it stays subscribed
and nothing needs manual refreshing. The `--once` variant backfills and exits.

| Command | |
|---|---|
| `npm run reconcile` | Compare projection against the ledger |
| `npm run drift` | Deliberately corrupt a holding |
| `npm run project -- --rebuild` | Wipe and replay the whole log |

---

## Documentation

- **[`docs/MANUAL.md`](docs/MANUAL.md)** — architecture, schema, and why each
  decision is what it is. Written for whoever picks this up in six months.
- **[`docs/build-log.md`](docs/build-log.md)** — chronological account of
  building it, wrong turns included.

## Related

- **[xrpl-rwa-cookbook](https://github.com/hamzaaziz1/xrpl-rwa-cookbook)** —
  standalone runnable scripts for each ledger primitive used here
- **[xrpl-why](https://github.com/hamzaaziz1/xrpl-why)** — diagnoses failed XRPL
  transactions by inspecting ledger state. On npm.

---

Testnet only. Nothing here should touch mainnet.
