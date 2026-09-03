/**
 * Projection: ledger_events -> holdings.
 *
 * Reads events in (ledger_index, tx_index) order and applies balance
 * changes. Advances the watermark in the SAME database transaction as
 * the balance updates, so a crash mid-batch resumes from a consistent
 * point and replay is harmless.
 *
 * Three things worth knowing:
 *
 *   - Failed transactions still land in ledgers. Anything that isn't
 *     tesSUCCESS is skipped.
 *
 *   - Balance changes come from transaction METADATA, not from the
 *     transaction's own fields. The `Amount` on a Payment is what was
 *     requested; the metadata records what actually moved. Reading
 *     `Amount` is a classic and quiet source of wrong balances.
 *     `getBalanceChanges` from xrpl.js does the metadata walk for us.
 *
 *   - `getBalanceChanges` reports each trust line from BOTH sides, and
 *     the `issuer` field means different things on each. See below.
 */
import { getBalanceChanges } from 'xrpl'
import { pool, query } from '../db/pool.js'

interface EventRow {
  tx_hash: string
  ledger_index: string
  tx_index: number
  tx_result: string
  raw: { tx: any; meta: any }
}

/**
 * THE DIRECTIONAL TRAP.
 *
 * A trust line is a two-sided object, and `getBalanceChanges` emits a
 * row for each side. On the HOLDER's row, `issuer` is the token issuer,
 * which is what you'd expect. On the ISSUER's own row, `issuer` is the
 * COUNTERPARTY — the holder.
 *
 * So issuing 500 PRP to alice and 100 to bob produces:
 *
 *   (account=alice,  issuer=ISSUER, +400)   <- issuer means issuer
 *   (account=bob,    issuer=ISSUER, +100)   <- issuer means issuer
 *   (account=ISSUER, issuer=alice,  -400)   <- issuer means counterparty
 *   (account=ISSUER, issuer=bob,    -100)   <- issuer means counterparty
 *
 * Stored raw, the `issuer` column means two different things depending
 * on which row you read, and the issuer's position is split across one
 * row per holder instead of being a single number.
 *
 * Canonicalizing: if the account whose balance changed is itself a known
 * token issuer, rewrite `issuer` to that account. The rows then collapse
 * through the ON CONFLICT sum into one (-500), and the column means the
 * same thing everywhere.
 *
 * The negative balance is correct and useful: negated, the issuer's
 * balance is total units outstanding.
 */
function canonicalize(
  account: string,
  currency: string,
  issuer: string,
  knownIssuers: Set<string>,
): { currency: string; issuer: string; account: string } {
  if (knownIssuers.has(account)) {
    return { currency, issuer: account, account }
  }
  return { currency, issuer, account }
}

async function loadKnownIssuers(): Promise<Set<string>> {
  const rows = await query<{ issuer: string }>(`select distinct issuer from assets`)
  return new Set(rows.map(r => r.issuer))
}

export async function project(opts: { verbose?: boolean } = {}) {
  const knownIssuers = await loadKnownIssuers()

  const [wm] = await query<{ last_projected_ledger: string; last_projected_tx: number }>(
    `select last_projected_ledger, last_projected_tx from sync_state where id = 1`,
  )
  const fromLedger = Number(wm?.last_projected_ledger ?? 0)
  const fromTx = Number(wm?.last_projected_tx ?? 0)

  const events = await query<EventRow>(
    `select tx_hash, ledger_index, tx_index, tx_result, raw
       from ledger_events
      where (ledger_index, tx_index) > ($1, $2)
      order by ledger_index, tx_index`,
    [fromLedger, fromTx],
  )

  if (events.length === 0) {
    if (opts.verbose) console.log('projection up to date')
    return { applied: 0, skipped: 0 }
  }

  const client = await pool.connect()
  let applied = 0
  let skipped = 0

  try {
    await client.query('begin')

    for (const ev of events) {
      const ledgerIndex = Number(ev.ledger_index)

      // failed transactions consumed a fee and landed in a ledger,
      // but changed no balances. skip them.
      if (ev.tx_result !== 'tesSUCCESS') {
        skipped++
        continue
      }

      let changes: any[]
      try {
        changes = getBalanceChanges(ev.raw.meta)
      } catch {
        skipped++
        continue
      }

      for (const change of changes) {
        for (const bal of change.balances ?? []) {
          // XRP has no issuer and isn't the asset we're tracking.
          if (!bal.issuer || bal.currency === 'XRP') continue

          const k = canonicalize(
            change.account, bal.currency, bal.issuer, knownIssuers,
          )

          await client.query(
            `insert into holdings
               (currency, issuer, account, balance, last_ledger_index, last_tx_index)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (currency, issuer, account) do update
               set balance = holdings.balance + excluded.balance,
                   last_ledger_index = excluded.last_ledger_index,
                   last_tx_index = excluded.last_tx_index`,
            [k.currency, k.issuer, k.account, bal.value, ledgerIndex, ev.tx_index],
          )
        }
      }
      applied++
    }

    const last = events[events.length - 1]
    await client.query(
      `update sync_state
          set last_projected_ledger = $1,
              last_projected_tx = $2,
              updated_at = now()
        where id = 1`,
      [Number(last.ledger_index), last.tx_index],
    )

    await client.query('commit')
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    client.release()
  }

  if (opts.verbose) {
    console.log(`projected ${applied} events (${skipped} skipped)`)
  }
  return { applied, skipped }
}

/**
 * Wipe the projection and rebuild it from scratch.
 *
 * This is the operation the determinism test relies on: if replaying
 * the log produces different state, the projection is not a pure
 * function of the log and cannot be trusted.
 */
export async function rebuild(opts: { verbose?: boolean } = {}) {
  await pool.query('truncate holdings')
  await pool.query(
    `update sync_state set last_projected_ledger = 0, last_projected_tx = 0 where id = 1`,
  )
  if (opts.verbose) console.log('projection wiped, replaying...')
  return project(opts)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const doRebuild = process.argv.includes('--rebuild')
  if (doRebuild) await rebuild({ verbose: true })
  else await project({ verbose: true })
  await pool.end()
}
