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
import { credentialFrom, applyCredential } from './credentials.js'

interface EventRow {
  tx_hash: string
  ledger_index: string
  tx_index: number
  tx_result: string
  raw: { tx: any; meta: any }
}

export async function project(opts: { verbose?: boolean } = {}) {
  // A trust line is two-sided. getBalanceChanges emits a row per side,
  // and on the ISSUER's own row the `issuer` field is the COUNTERPARTY,
  // not the issuer. Left raw, the issuer's position splits into one row
  // per holder and the column means two different things. Rewriting it
  // to the account itself collapses them into one.
  const knownIssuers = new Set(
    (await query<{ issuer: string }>('select distinct issuer from assets'))
      .map(r => r.issuer),
  )
  if (knownIssuers.size === 0) {
    throw new Error('no assets in registry — seed before projecting')
  }
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

      // Freeze is a TrustSet from the issuer carrying tfSetFreeze or
      // tfClearFreeze. It changes no balances, so like credentials it
      // has to be handled separately.
      //
      // DIRECTION: on this TrustSet, `LimitAmount.issuer` is the HOLDER
      // being frozen, not the token issuer. The signer is the issuer.
      const tx = ev.raw.tx
      if (tx?.TransactionType === 'TrustSet' && typeof tx.Flags === 'number') {
        const SET_FREEZE = 0x00100000
        const CLEAR_FREEZE = 0x00200000
        const setting = (tx.Flags & SET_FREEZE) !== 0
        const clearing = (tx.Flags & CLEAR_FREEZE) !== 0

        if ((setting || clearing) && tx.LimitAmount?.issuer) {
          await client.query(
            `insert into holdings
               (currency, issuer, account, balance, frozen, frozen_ledger,
                last_ledger_index, last_tx_index)
             values ($1, $2, $3, 0, $4, $5, $6, $7)
             on conflict (currency, issuer, account) do update
               set frozen = excluded.frozen,
                   frozen_ledger = excluded.frozen_ledger`,
            [tx.LimitAmount.currency, tx.Account, tx.LimitAmount.issuer,
             setting, setting ? ledgerIndex : null, ledgerIndex, ev.tx_index],
          )
          applied++
          continue
        }
      }

      // Credential events change no balances, so they must be handled
      // separately. This is the whole point of keeping ledger_events a
      // faithful log: new interpretations can be added and replayed
      // without re-fetching anything.
      const cred = credentialFrom(ev.raw.tx)
      if (cred) {
        await applyCredential(client, cred, ledgerIndex)
        applied++
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
            [bal.currency,
             knownIssuers.has(change.account) ? change.account : bal.issuer,
             change.account, bal.value,
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
  await pool.query('truncate credentials')
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
