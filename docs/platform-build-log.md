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

---

## day 8 — three views

built the frontend. vite, react, typescript, and deliberately plain — no
gradients, no floating cards, no dashboard aesthetic. a regulated-finance
internal tool should look like one.

one global two-second poll feeding all three views, rather than each action
polling its own intent. one timer, one snapshot, and everything updates
together. it also makes the demo read better: things visibly resolve on their
own while you're looking at them.

every transaction hash links to testnet.xrpl.org. anyone reviewing this can
verify every claim against the actual ledger instead of trusting my screen.

three things i'm pleased with:

**the clawback confirmation shows the holder's balance and explains that
clawback clamps.** that warning exists because i found the behaviour yesterday,
not because it's good practice in the abstract.

**the eligibility panel has three stages, not two** — submitted, issued,
accepted — with a note explaining that credentials are two-sided. that's the
day-two finding surfaced as a product decision. most implementations would
collapse it to a boolean and show approved users as rejected.

**failure reasons get their own column.** a confirmed operation tells you it
worked; a failed one tells you what went wrong and how to fix it. the failure
carries strictly more information, so it gets at least as much room.

---

## day 8 — an hour lost to an empty body

clicking Approve gave a browser alert saying "Bad Request". curl to the same
endpoint returned 202.

i guessed twice and was wrong twice. then i turned on fastify's logger and it
said it outright:

```
FST_ERR_CTP_EMPTY_JSON_BODY
Body cannot be empty when content-type is set to 'application/json'
```

the approve endpoint takes no body. my API client set the content-type header
anyway. fastify tried to parse an empty string as JSON and returned 400 before
the handler ever ran. curl didn't set the header, so it never happened there.

two lessons.

**turn the logs on first.** i spent twenty minutes inferring from symptoms when
the server already knew the answer and was willing to say it.

**that alert was terrible.** "Bad Request" tells an operator nothing — on a
project whose entire argument is that errors should carry real reasons. i built
`xrpl-why` for exactly this and then wrote `alert(e.message)` in my own UI.

---

## day 8 — the gap i built and didn't notice

then a worse one, and it's architectural.

after approving carol, she sat on `approving` forever. the credential confirmed
on-ledger. nothing moved her to `approved`.

because **`kyc_status` is a column i write, and `holdings.balance` is projected
from ledger events.** one of those can drift from reality. the other can't.

i built the correct pattern on day 4 for balances and then didn't apply it to
credentials.

it got worse. i reset her status to `pending` in the database to retest, which
did nothing to the on-ledger credential. the next approval returned
`tecDUPLICATE` — the ledger correctly reporting the credential already exists.

so: the registry said pending, the ledger said approved, and only the registry
was wrong. that is precisely the drift this entire system exists to detect, in
the one place i didn't apply the pattern.

the reconciler didn't catch it either, because it only checks balances.

---

## day 8 — what i'm going to do about it

the patch is to treat `tecDUPLICATE` as success, since it means the desired end
state already exists. that stops the immediate bleeding and is genuinely
correct.

the fix is projection. credentials become a table derived from
`CredentialCreate`, `CredentialAccept` and `CredentialDelete` events — all of
which ingest already stores. `kyc_status` becomes derived rather than written.
the optimistic `approving` write disappears entirely, because in-flight state
already lives in `intents`. and the reconciler gets extended to check
credentials the same way it checks balances.

two or three hours, and it touches the most tested part of the system, so it
wants a clear head rather than the end of a long evening.

what bothers me is that if someone asks "why is balance projected but KYC status
stored?", the honest answer right now is "i ran out of time." that's a weaker
answer than the rest of this deserves.

writing it into the manual as a known gap tonight, and fixing it tomorrow.

---

---

## day 9 — closing the gap

spent the morning making credentials work the way balances already did.

a `credentials` table, thirty lines of projection reading `CredentialCreate`,
`CredentialAccept` and `CredentialDelete` out of the event log, and `kyc_status`
derived rather than written.

the part that still slightly amazes me: **i built that table from history without
touching the ledger.** the events were already in `ledger_events` from days ago.
adding a new interpretation and replaying was the entire migration.

that's the third time the day-4 decision has paid off. keep the log faithful,
keep everything downstream disposable, and changing how you interpret history
costs nothing.

---

## day 9 — the fifth direction trap

the three credential transactions name the subject differently:

```
CredentialCreate   submitted by the ISSUER   -> subject is `Subject`
CredentialDelete   submitted by either       -> `Subject`, falling back to `Account`
CredentialAccept   submitted by the SUBJECT  -> subject is `Account`, `Issuer` separate
```

read `Subject` on an Accept and you get undefined, and the acceptance silently
attaches to nothing.

i saw this one coming. not because i'm getting better at XRPL, but because i
wrote the rule down on day 4 and now check for it by reflex: **a trust line — or
a credential — is a relationship, and every field describes a direction within
it.**

five instances now. `authorized` vs `peer_authorized`. freeze on which side.
`issuer` meaning counterparty. `account_lines` rows keyed by the other party.
and now this.

---

## day 9 — what the projection found on its first run

```
subject   issued  accepted  revoked
alice     t       t         f
bob       t       t         f
carol     t       f         f
```

**carol has never been eligible.**

her credential was issued and never accepted. on XRPL that means no domain
membership, which means she couldn't have traded. the stored `kyc_status` column
had said `approved` for two days.

the registry was claiming a state that was never true on the ledger. nothing
detected it, because the reconciler only checked balances.

i built this projection to fix an inconsistency i'd noticed, and it immediately
surfaced a second one i hadn't. that's the argument for derived state in a single
example — not "it's cleaner", but "the stored version was lying and i didn't
know."

---

## day 9 — extending the reconciler

it now checks credentials as well as balances. existence in both directions, and
acceptance state.

then the test that matters, because an alarm you've never seen fire is untested:

```
update credentials set accepted_at = now() where subject = carol
npm run reconcile
  [CRITICAL] acceptance state disagrees — an unaccepted credential
             grants no domain membership

npm run project -- --rebuild
npm run reconcile
  no drift
```

i deliberately put the projection into exactly the state the stored column had
been in for two days, and it was caught in one run.

---

## where this leaves the system

every piece of state the ledger knows about is projected from the event log.
nothing is optimistically written. the reconciler checks all of it, in both
directions. repair is always replay.

the approve endpoint no longer writes an `approving` status — in-flight state
lives in `intents`, and duplicating it in the registry was the original mistake
in miniature.

one imperfection left, noted in the manual: the projection stamps timestamps with
`now()` rather than the ledger close time, so `issued_at` records when i
processed the event rather than when it happened. the ledger index columns are
correct. a faithful projection shouldn't have that gap.

---

---

## day 9 — the arc, end to end

added the missing step: the investor accepting their own credential.

that's the piece that makes the whole onboarding story work. apply → issuer
approves → **investor accepts** → eligible. the third step is the one that
actually confers domain membership, and until today the app had no way to do it.

the transaction is signed by the investor, not the issuer. that's the entire
point of two-sided credentials — nobody can attach an attribute to your account
without your signature. it would have been easy to have the backend sign it on
their behalf and lose the distinction entirely.

carol now goes pending → issued → approved in the browser, three real ledger
transactions, no terminal.

worth stating what changed between yesterday and today. yesterday she read
`approved` because a column said so, and it was false. today she reads
`approved` because there is an accepted credential on the XRP Ledger and the
projection derived it. same word, completely different epistemics.

---

## day 9 — "why do i have to run a command?"

i'd been running `npm run ingest -- --once`, which backfills and exits. so after
every action i was manually re-running ingest and project to see the result, and
i'd started to assume that was the design.

it wasn't. drop the flag and ingest stays subscribed over a websocket. the only
genuine gap was that the projection didn't run on a timer — ingest wrote to the
log and nothing applied it. ten lines.

now: four processes, no commands. click approve, watch it resolve. that's what a
reviewer will actually experience, and i'd been demoing it to myself in the
wrong mode for two days.

lesson: **the way you run something during development quietly becomes your
mental model of how it works.** i had convinced myself the flow was manual
because my flow was manual.

---

## day 9 — the reset didn't reset

clicked approve, nothing happened. no new intent, no ledger transaction.

`reset.ts` drops six tables. `intents`, `credentials` and `account_sequences`
weren't among them, so a reset left stale intents behind — including one with
the idempotency key `approve:inv-003` from a previous database. `create()`
correctly returned the existing intent, the API returned 202 with its id, and
the worker had nothing to do because that intent had resolved days ago.

two bugs in one. the reset was incomplete, and the idempotency key was a fixed
string, meaning an investor could be approved exactly once ever — a revoke
followed by re-approval would silently return the old intent.

idempotency keys that never change aren't idempotency, they're a permanent lock.

---

## day 9 — freeze was invisible

froze a holder and the register looked identical. no way to tell who was frozen,
and both Freeze and Unfreeze stayed clickable.

the data simply wasn't there. `holdings` tracked balances and nothing else, and
freeze lives on the trust line.

two options. read `account_lines` live in the API and merge the freeze flag in —
quick, accurate, and the API reading the ledger directly rather than serving the
projection. or project it properly from `TrustSet` events.

took the second. the shortcut would have undercut the thing this project is
arguing, in the API layer, for the sake of twenty minutes.

and the direction trap once more: on a freeze `TrustSet`, `LimitAmount.issuer`
is the **holder being frozen**, not the token issuer. sixth instance. i checked
for it before writing the code rather than after.

then the part that still feels like a trick: the column didn't exist when alice
was frozen. i added it, replayed the log, and her freeze was already there. no
ledger queries, no migration script, no backfill job.

fourth time the day-4 decision has paid for itself.

---

## where this leaves things

every piece of state the ledger knows about — balances, credentials, freeze — is
projected from the event log. nothing is optimistically written. the reconciler
checks balances and credentials in both directions. repair is always replay.

the UI shows what it can prove and doesn't guess. an operator can see freeze
state and can't take a contradictory action.

remaining, both small and both documented: timestamps use `now()` rather than
ledger close time, and the investor view doesn't yet show a holder their own
freeze state — which is arguably the more important place to show it, since it
explains why they can't trade.

---

---

## day 10 — deployed

it's on the internet. one URL, real testnet data, no localhost.

that's the difference between something i demo and something i send. a link
someone can open on their phone.

railway, four services: postgres, api, ingest, worker. the last two hold
long-running websockets to the ledger and expose no HTTP, which is the
constraint that rules out most serverless hosting — i couldn't have put this on
vercel.

kept them as three separate processes rather than merging them into one. the
argument is the same one from day 6: if the worker dies, ingest keeps recording
ledger events. merge them and a single failure takes out both, and "if the API
dies the intent survives" stops being true. that sentence was the whole
justification for the intents table, so collapsing the processes to save
resources would have quietly undone it.

---

## day 10 — the frontend problem

free plan allows four services. postgres plus three processes is four. no room
for the frontend.

three options: host it separately on vercel, pay for a fifth service, or serve
it from the API.

took the third. the root Dockerfile now builds the frontend in a first stage and
copies `dist/` into the backend image, where fastify serves it. one origin for
the app and the API, no CORS to configure, and the client and API can never
disagree about versions.

it slightly cuts against the separation argument — the API now has two jobs. but
serving static assets isn't a process concern, it's the same HTTP server doing
one extra thing. the processes that could fail independently still do.

one thing i'd have got wrong without checking: **vite bakes environment
variables in at build time, not runtime.** setting `VITE_API_URL` as a railway
runtime variable does nothing. it has to be present when `npm run build` runs,
which is why it's an ENV in the docker build stage.

---

## day 10 — three bugs that were one bug

spent a while chasing buttons that didn't lock during submission.

**first**: the approve button had a guard that never fired. `liveFor` searched
intent JSON for the investor's address, but `GET /api/intents` didn't select
`params` — so the address was never in the JSON. no error, no symptom, just a
button that stayed clickable.

that's the same shape as the reconciler that only checked balances. **the check
existed and covered less than it appeared to.** those are harder to find than
crashes, because there's nothing to notice until someone double-clicks.

**second**: the accept-credential button used local `accepting` state, which
clears when the POST returns. the POST returns in milliseconds; the ledger takes
seconds. so it was unguarded for most of the actual operation.

the underlying rule, which i now think is the real lesson: **local request state
and ledger state are different things.** a button should follow the second. the
fetch resolving tells you the server accepted your intent, not that anything
happened.

**third**: chasing a bug that wasn't there. carol showed `issued` after i clicked
accept, so i assumed the guard had failed again. the intent had confirmed, the
projection had updated, the database was correct — the page just hadn't polled
yet.

five to ten seconds between an action and its visible result, and "the UI hasn't
caught up" looks exactly like "it didn't work". i've now been caught by that
twice and should check the database before concluding anything is broken.

---

## where this is

**xrpl-rwa-cookbook** — six scripts, the full compliance arc, one command.
**xrpl-why** — published to npm, five integration tests, no mocks.
**xrpl-rwa-platform** — deployed, three views, projected state, reconciled both
directions, async writes with an audit trail.
**an article** on the five causes of `tecPATH_DRY`.

ten days from no XRPL experience.

what's left is small: ledger close timestamps instead of `now()`, freeze state
in the investor view, and a README that explains what this is to someone opening
the link cold. that last one probably matters most now — the code is done, and
the thing standing between it and a good first impression is thirty lines of
prose at the top of a repo.

---

---

## day 11 — the secondary market

the obvious gap: one asset, created by a seed script, and the only way anyone
got units was the seed doing it for them. no way to trade through the UI.

split into two features, and the second is the one that matters. "add an asset"
is registry work. "approved investors trade a restricted asset among
themselves" is what the whole system is about, and it was only ever proven by a
seed script.

did it properly rather than a buy button: limit offers both sides, a real order
book, cancellation.

**offers are ledger objects, so they get projected** like everything else.
`OfferCreate` carrying a `DomainID` only matches offers carrying the same
domain, so a non-member's offer can never cross it. they're not rejected at
trade time — they were never in the same book.

the API also checks membership before creating an intent. the ledger would
refuse anyway, but that answer arrives eight seconds later as
`tecNO_PERMISSION`. carol tried to bid and got back:

```
not a member of the permissioned domain — an accepted, unrevoked
credential is required to trade
```

immediately, in a sentence she could act on.

---

## day 11 — two things about offers i had to find out

**an offer can be closed by someone else's transaction.** when bob's offer
crosses alice's resting one, alice's is deleted and alice submitted nothing. a
projection built from each account's own transactions would keep showing offers
that don't exist.

the deletion is in the *crossing* transaction's metadata as a `DeletedNode`. so
the projection reads deletions from metadata regardless of who submitted. same
lesson as the reconciler in a new place: **your own actions are not the only
thing that changes your state.**

that one i designed for. the next one i didn't.

**an offer that crosses fully never rests.** first test run left a phantom: bob's
bid sitting open in my projection, and `account_offers` on the ledger returning
an empty array.

his offer crossed completely on submission, so it never became a ledger object.
no `CreatedNode`, and no `DeletedNode` ever coming because nothing was created.
i was recording it and waiting forever for a deletion.

**the projection was manufacturing exactly the drift the reconciler exists to
catch.** fix was to check for the `CreatedNode` before inserting — if it didn't
rest, there's nothing to track.

---

## day 11 — the reconciler found a bug i'd written an hour earlier

placed alice's ask, had bob cross it, checked the balances. alice 500, bob
absent.

but both intents said `tesSUCCESS`. alice's ask showed `filled`. the trade had
clearly happened.

ran the reconciler, mostly out of habit:

```
2 finding(s):
  [CRITICAL] r4mexxnVcfbN... PRP
    ledger 350 vs projection 500
  [CRITICAL] rpeyVqFXQFtP... PRP
    ledger has a balance the projection never recorded
      — likely a missed event
```

the ledger said 350. my projection said 500. and the second finding named the
cause outright.

the bug: my offer-handling block ended with `continue`, which skipped the
balance-change code below it. **an OfferCreate that crosses is both an offer
event and a set of balance changes**, and i was handling one and dropping the
other.

nothing errored. every transaction succeeded. the trade was real on the ledger.
only the projection was wrong — which is precisely the case where nothing else
would have told me.

what i want to record is that **a component i built two weeks ago for a
different purpose caught a regression in code i'd written an hour earlier,
unprompted, and diagnosed it correctly.** i wasn't testing the reconciler. i was
debugging, reached for it, and it just answered.

that's the claim the readme makes about this system, demonstrated on itself. i
couldn't have staged a better example if i'd tried.

---

## where this leaves it

alice 350, bob 150, book empty, no drift. a full secondary market trade between
two approved investors, initiated through the API, with a non-member refused at
the boundary.

next is the UI for it — order book in the investor view, place and cancel,
hidden from non-members so the eligibility gate is the thing you actually see
rather than a market you can look at but not enter.

---

*continues.*
