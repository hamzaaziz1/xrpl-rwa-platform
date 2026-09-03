/**
 * Projection: ledger_events -> holdings.
 *
 * Reads events in (ledger_index, tx_index) order and applies balance
 * changes. Advances the watermark in the SAME database transaction as
 * the balance updates, so a crash mid-batch resumes from a consistent
 * point and replay is harmless.
 *
 * Two things worth knowing:
 *
 *   - Failed transactions still land in ledgers. Anything that isn't
 *     tesSUCCESS is skipped.
 *
 *   - Balance changes come from transaction METADATA, not from the
 *     transaction's own fields. The `Amount` on a Payment is what was
 *     requested; the metadata records what actually moved. Reading
 *     `Amount` is a classic and quiet source of wrong balances.
 *
 * `getBalanceChanges` from xrpl.js does the metadata walk for us —
 * diffing RippleState nodes and getting the sign convention right.
 * Hand-rolling it is possible and not worth the bugs.
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

export async function project(opts: { verbose?: boolean } = {}) {
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

          await client.query(
            `insert into holdings
               (currency, issuer, account, balance, last_ledger_index, last_tx_index)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (currency, issuer, account) do update
               set balance = holdings.balance + excluded.balance,
                   last_ledger_index = excluded.last_ledger_index,
                   last_tx_index = excluded.last_tx_index`,
            [bal.currency, bal.issuer, change.account, bal.value,
             ledgerIndex, ev.tx_index],
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
 * This is the operation the determinism test relies on: if replaying
 * produces different state, the projection is not a pure function of
 * the log and cannot be trusted.
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
