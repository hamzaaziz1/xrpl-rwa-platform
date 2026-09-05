# build log: the platform

continues from the cookbook. same project, bigger scope — this is the actual
application: an issuer, investors, a regulator, and an off-chain registry that
has to stay honest with the ledger forever.

written as i go, wrong turns included.

---

## day 4 — deciding what this is before building it

the cookbook proved i can drive the ledger primitives. that's not a portfolio
piece on its own, it's six scripts. the thing worth building is the system
around them, and specifically the part nobody sees from outside: keeping a legal
system of record and a distributed ledger in agreement.

that's the actual hard problem in RWA tokenization. minting a token is a
tutorial. reconciliation is the job.

four decisions made before any code:

**KYC is a form with a human approval step**, not a button. the interesting part
isn't verifying documents, it's the gap between "approved" and "credential
accepted" — the three-state problem i found on day two. a demo that shows a user
sitting in that middle state is showing something real.

**custody is custodial.** the backend holds keys and signs on behalf of
investors. that's what production platforms actually do — institutions won't ask
retail users to manage seed phrases. it's also honest to say so and document what
real key management would require, rather than pretending a testnet demo has
solved custody.

**the regulator view gets a deliberate drift injector.** the reconciler is the
centrepiece, but drift is normally absent, so a panel reading "no drift" proves
nothing. a demo-mode button that writes a wrong balance directly into the
projection, and a panel that catches it seconds later, demonstrates the mechanism
instead of asserting it exists. artificial, and honest about being artificial.

**hosting needs a long-running websocket**, which rules out most serverless
platforms. the ingest service has to stay connected to the ledger.

---

## day 4 — the log is a log

first real design correction, and it came before any code ran.

my schema had `ledger_events` with `currency`, `issuer`, and `delta` columns —
as if each transaction were a single balance change.

it isn't. one payment can move balances for several accounts at once. a DEX
trade crossing an offer touches both parties *and* the issuer. those columns
can't represent it.

so `ledger_events` became one row per *transaction*, with the full metadata in
`raw`, and balance changes derived at projection time.

that's the better separation regardless. the log records what happened;
interpretation belongs downstream. and it means i can change how balances are
computed and replay, without re-fetching anything from the ledger.

which i then immediately needed. more below.

---

## day 4 — subscribe before you backfill

the ingest has to catch up on history and then stay live. the obvious ordering
is: read watermark, backfill, subscribe.

that's wrong, and it's wrong in a way that never shows up in testing. between
the last backfilled ledger and the first streamed one there's a window — small,
maybe a second — where transactions land and nobody records them.

correct order: subscribe first and **buffer** what arrives, then read the
watermark, then backfill, then drain the buffer, then go live. the buffer covers
the gap.

it's four lines of difference and it's the sort of thing that produces a
"why is one transaction missing from last tuesday" bug six months later.

---

## day 4 — the amount field is a lie

not really a lie. but a payment's `Amount` is what was *requested*, and the
transaction metadata records what actually *moved*. they differ on partial
payments and on any path carrying a transfer fee.

reading `Amount` and calling it a balance change is a quiet, plausible-looking
source of wrong numbers. `getBalanceChanges` from xrpl.js walks the metadata,
diffs the RippleState nodes, and gets the sign convention right. i could
hand-roll it. it would take an afternoon and i'd get the signs wrong at least
once.

---

## day 4 — the same bug for the third time

first run of the projection, and the balances were nearly right:

```
alice   400 PRP
bob     100 PRP
issuer  -100 PRP
issuer  -400 PRP
```

alice and bob correct. the issuer appearing twice.

they weren't duplicates. the primary key includes `issuer`, and those two rows
had *different* issuer values — the query just wasn't showing that column.

here's what's happening. `getBalanceChanges` reports each trust line from both
sides. on the holder's row, `issuer` means the token issuer, which is what you'd
expect. on the **issuer's own row**, `issuer` means the counterparty. so you get
`(account=issuer, issuer=alice, -400)` and `(account=issuer, issuer=bob, -100)`.

both accurate. but the column means two different things depending on which row
you read, and the issuer's position is split across one row per holder instead
of being a single number.

fix: if the account whose balance changed is itself a known issuer, rewrite
`issuer` to that account. the rows collapse through the existing ON CONFLICT sum
into one. `-500`, which negated is total units outstanding — and matches
`total_units` in the registry.

what i actually want to record is that **this is the third time the same bug has
bitten me in this project.**

- day 2: `authorized` on a trust line means *this account authorized the
  counterparty*. i wanted `peer_authorized`.
- day 3: a freeze can be on the sender's line or the destination's. my diagnostic
  code checked only the destination and confidently blamed the wrong thing.
- day 4: `issuer` on a balance change means counterparty when you're reading the
  issuer's own row.

three surprises, one rule: **a trust line is a two-sided object, and every field
on it means something different depending on which side you're reading from.**

i've been treating each of these as a separate gotcha. it's one gotcha. the
whole model of a trust line is a relationship, not a possession, and every field
describes a direction within that relationship. once i hold that, the three
collapse into a single thing to check.

there'll be a fourth. at least now i know what shape it'll be.

---

## day 4 — the replay earned its keep immediately

the canonicalization fix changed how balances are computed from the log.

applying it: `npm run project -- --rebuild`. truncate holdings, replay all 19
events with the new logic, done. no re-fetching from the ledger, no migration,
no reconciliation of old and new.

that's the property the whole design was built around, and it paid off within an
hour of existing rather than in some hypothetical future.

it also makes the reconciler meaningful. a projection you can rebuild from
scratch and verify against the source is trustworthy. one that accumulates state
you can't reconstruct is just a database you hope is right.

---

## where stage 1 landed

```
alice   400 PRP
bob     100 PRP
issuer -500 PRP
```

ledger → events → projection, with correct balances derived from metadata.

three repos public now. next is the reconciler: compare the projection against
live ledger state, record any drift. that's the piece that turns this from a
demo into something you could imagine operating.

---

---

## day 5 — building the thing that assumes i'm wrong

the reconciler. reads live balances from the ledger, compares them against the
projection, records anything that disagrees.

the obvious objection: the projection is correct by construction, so what's
there to find?

three answers, and the first one already happened. **my projection logic was
wrong yesterday.** the issuer rows split across one row per holder, balances
looked plausible, and i only caught it because i happened to eyeball the output.
a reconciler catches that class of bug without anyone squinting at a table.

second: **events can be missed.** a dropped websocket, a gap in the backfill, an
account added to the registry after transactions already happened against it.
the log is only complete if ingest never failed, and assuming that is how you end
up with a database that's internally consistent and quietly incomplete.

third: **the ledger is the authority.** verifying against it is the only real
check. everything else is checking my database against itself.

so it checks both directions:

- projection has a balance the ledger doesn't → my logic is wrong
- ledger has a balance the projection never recorded → i missed an event

the second one is the interesting failure. everything looks fine. all the
numbers add up. and the data is simply not all there.

---

## day 5 — the fourth one, as predicted

yesterday i wrote that trust lines are two-sided and every field means something
different depending on which side you read, and that there'd be a fourth
instance.

it arrived within a day.

`account_lines` returns one row per trust line, and the `account` field on each
row is the **counterparty**, not the account you queried. so when i query the
issuer, i get one row per holder, each keyed by that holder.

which means the projection's single canonical row (`-500`) and the ledger's two
rows (`-400`, `-100`) aren't directly comparable. compare them naively and every
run reports drift on the issuer, forever.

that's worse than missing drift. an alarm that's always on is an alarm you learn
to ignore, and then the real one arrives and you scroll past it.

fix is to sum the ledger side for known issuers before comparing. four lines.
but i only knew to look for it because i'd already named the pattern.

that's the argument for writing down the *shape* of a bug rather than the bug.
three separate gotchas i'd have kept re-discovering; one rule i can now check
against.

---

## day 5 — an alarm you've never seen fire

the reconciler reported no drift, which is correct and proves nothing. a
detector that has only ever said "all clear" is untested.

so: a script that deliberately corrupts the projection. writes a wrong balance
straight into `holdings`, bypassing the projection entirely.

that's deliberately the shape of a real bug. the database is internally
consistent — nothing about the row looks odd — and it disagrees with the ledger.

```
npm run drift
  bob: was 100, now 237

npm run reconcile
  [CRITICAL] raju47NwQMd7... PRP
    ledger 100 vs projection 237
```

caught it.

then the part i actually care about:

```
npm run project -- --rebuild
  projection wiped, replaying...
  projected 19 events (0 skipped)

npm run reconcile
  reconciled 4 accounts — no drift
```

**the repair isn't a patch.** nothing corrected the bad row. the projection was
thrown away and rebuilt from the event log, and the corruption couldn't survive
because it was never in the log — it was written into a derived table.

this is the payoff for the design decision on day 4. keeping `ledger_events` a
faithful record of transactions, and `holdings` disposable, means any drift is
recoverable by definition rather than by cleverness.

i think that's the sentence worth leading with when i show this to someone. not
"my reconciler works." **"the projection is a pure function of the log, so drift
is always recoverable."** the reconciler is just how you find out you need to.

it's also the demo moment. a regulator panel that permanently reads "all clear"
demonstrates nothing. one that catches something on screen, and then repairs
itself, demonstrates the mechanism.

---

## where stage 2 landed

corrupt → detect → repair → verify. full cycle, working.

the intellectually interesting half of this project is done. what's left — an
API, three UIs, deployment — is mostly work rather than design.

next is the API and the issuer view.

---

---

## day 6 — arguing myself out of the easy option

started on the API. read endpoints first, which were unremarkable — assets,
holdings, investors, reconciliation, the event log.

one bug worth recording though. the reconciliation endpoint reported drift that
i'd already repaired. the finding was sitting there with `resolved_at` null,
because nothing ever closed it.

that's the same failure as yesterday's issuer comparison arriving from a
different direction: **an alarm that stays on after the problem is gone.** a
regulator panel showing a permanent alert is worse than no panel, because people
learn to scroll past it, and then the real one arrives and gets scrolled past
too.

fix: each reconciler run knows the current truth, so anything unresolved that
isn't in this run's findings has been fixed and gets closed automatically. also
stopped it inserting duplicate rows for the same still-open problem.

both of these would have looked completely fine in a screenshot.

---

## day 6 — the write path, done properly

the question was whether writes should block until the ledger validates, or
return immediately and let the client poll.

claude argued for blocking — eight seconds is tolerable for a demo, and async
done badly is worse than sync. i pushed back, because in the real world these
systems are asynchronous and i think a CTO looks at exactly this.

we both ended up somewhere better than where either of us started. the point
isn't UX. **async only impresses if the hard parts are handled**, and the hard
parts are:

- an intents table recording what you meant to do, before you do it
- explicit `LastLedgerSequence` so an unconfirmed transaction is definitively
  dead rather than ambiguous
- sequence allocation under a lock
- a resolver that reconciles pending intents against the ledger

202-and-forget has none of those and is worse than blocking. it says "submitted"
while the ledger says nothing happened — which undercuts the exact claim the
reconciler makes.

so: the full version. and it turned out not to be plumbing at all.

---

## day 6 — the same idea, other direction

what i didn't see until it was built:

**read path** — the projection is a pure function of the log, and the reconciler
checks it against the ledger. what we believe vs what is true.

**write path** — intent is recorded before action, and the resolver checks the
ledger for the outcome. what we meant vs what happened.

it's the same discipline twice. never assume your database and the ledger agree.
record what you know, verify against the authority, make the gap explicit rather
than hoping it isn't there.

that's a position about building on ledgers, not a list of features. i think
that's the thing to lead with when i show this to someone.

---

## day 6 — the state that justifies the design

```
created ee0ab65e...  status=pending

npm run worker -- --once
  submitted  freeze
  resolved: 0 confirmed, 0 failed, 0 expired, 1 still pending

npm run worker -- --once
  confirmed  freeze  tesSUCCESS
```

the middle line is the whole thing. after the first pass the intent was
`submitted` and the worker honestly reported it didn't know the outcome yet. it
had sent a transaction and was waiting.

every fire-and-forget design has that window. almost none of them represent it.

then the full round trip: intent → submit → ledger validates → ingest picks it up
→ projection applies it → reconciler confirms no drift. both halves of the system
agreeing about the same event.

---

## day 6 — the things that only break under concurrency

two bugs designed around rather than encountered, which i want to record because
i'd have hit both eventually and been confused.

**sequence allocation needs a lock.** every XRPL transaction carries a sequence
number for its account, used exactly once, in order. reading the current sequence
from the ledger at submit time means two concurrent requests get the same number
— one lands, one fails with `tefPAST_SEQ`. works perfectly in testing. fails the
moment two people click at once.

**and resyncing isn't optional.** when a transaction expires, the sequence was
never consumed on-ledger, so my counter is ahead of reality. every subsequent
transaction from that account fails until the counter is pulled back. without
that, the account wedges permanently after the first expiry.

**submission has to be serial even with locked allocation.** the ledger rejects a
transaction whose sequence arrives before its predecessor. so allocating
correctly isn't enough — the order they go out in matters too.

none of these appear with one user clicking one button. all of them appear in
production.

---

## where day 6 landed

read endpoints working, full async write path proven end to end, `xrpl-why`
wired in so failures carry real reasons instead of `tec` codes.

next: write endpoints, then the three views.

---

---

## day 7 — the endpoints were the easy part

write endpoints today. they turned out to be about twenty lines each, because
everything difficult was already behind them. record an intent, return 202 with
its id, done.

that's the shape you want. the endpoints are thin because the design underneath
is doing the work.

202 rather than 200, deliberately. the request has been accepted, not completed.
returning 200 would claim an outcome i don't have yet, which is the exact lie
this whole design exists to avoid.

first freeze through HTTP:

```
created   19:40:10
submitted 19:40:14
resolved  19:40:21
```

eleven seconds end to end. the API returned in milliseconds. those three
timestamps are the honest record of an operation that took eleven seconds, and
they're queryable rather than invisible.

---

## day 7 — clawback doesn't do what i assumed

wanted a failure to test the diagnostics against, so i tried clawing back 99999
units from a holder with 400.

`tesSUCCESS`.

it took all 400. **clawback clamps to the available balance rather than
rejecting.**

which is reasonable when you think about what clawback is for — a court-ordered
recovery shouldn't fail because the balance moved since the order was written.
but it means "claw back 99999" silently means "take everything", and an operator
typing a wrong number gets no pushback at all.

so the issuer view has to show the holder's current balance right next to the
amount field, and probably cap the input. this is a UI requirement that came out
of protocol behaviour, which i wouldn't have found by reading docs.

it's also the second time this project has taught me the same lesson from a
different angle: the dangerous failures are the ones that return success.

---

## day 7 — my own library, in my own app

tried again for a real failure. issued tokens to an account with no trust line:

```json
{
  "status": "failed",
  "engine_result": "tecPATH_DRY",
  "failure_reason": "The destination has no trust line for PRP from rBx1...",
  "failure_fix": "The destination must submit a TrustSet transaction to opt in
                  before they can receive this token."
}
```

the ledger said `tecPATH_DRY`. the intent record says what actually went wrong
and what to do about it.

that's `xrpl-why` — the thing i published to npm on day three, after writing up
the five causes of that exact error — running inside this platform, on a real
failure, and producing something an operator could act on.

the write-up, the library and the application aren't three separate projects any
more. the article explains the problem, the package solves it, and the platform
uses it. i didn't plan that arc. it came out of solving the same problem twice
and noticing the second time.

---

## day 7 — the failure path is better than the success path

small observation, but it's changed how i'm thinking about the UI.

a confirmed intent tells you it worked. a failed one tells you what went wrong,
why, and how to fix it. the failure carries strictly more information.

most interfaces treat errors as an afterthought — a red toast that disappears in
four seconds. here the most useful output in the entire system is the thing that
appears when something breaks.

so failures get at least as much room in the UI as successes. probably more.

---

## where the backend landed

reads, writes, intents, worker, reconciler, diagnostics. everything the three
views need now exists behind HTTP.

next: the frontend. vite, react, typescript, and deliberately plain — a
regulated-finance internal tool should look like one. restraint reads as
judgement; polish on a demo reads as compensating for something.

---

*continues.*
