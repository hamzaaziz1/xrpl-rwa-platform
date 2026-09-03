/**
 * Ledger ingest.
 *
 * Writes every transaction touching a watched account into `ledger_events`,
 * append-only and idempotent on tx_hash.
 *
 * STARTUP ORDERING MATTERS. Do this in exactly this order:
 *
 *   1. open the subscription and BUFFER incoming events
 *   2. read the watermark
 *   3. backfill from the watermark via account_tx
 *   4. drain the buffer
 *   5. go live
 *
 * Subscribing *after* backfilling leaves a gap between the last
 * backfilled ledger and the first streamed one. It's a small window,
 * it won't show up in testing, and it will lose real transactions.
 */
import { Client } from 'xrpl'
import { connect } from '../xrpl-client.js'
import { pool, query } from '../db/pool.js'
import { normalize, type NormalizedTx } from './normalize.js'

/** Accounts to watch: the issuer, plus every investor we know about. */
export async function watchedAccounts(): Promise<string[]> {
  const rows = await query<{ account: string }>(`
    select issuer as account from assets
    union
    select account from investors where account is not null
  `)
  return rows.map(r => r.account).filter(Boolean)
}

async function store(tx: NormalizedTx): Promise<boolean> {
  const res = await pool.query(
    `insert into ledger_events
       (tx_hash, ledger_index, tx_index, tx_type, tx_result, account, raw)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (tx_hash) do nothing`,
    [tx.hash, tx.ledgerIndex, tx.txIndex, tx.txType, tx.txResult,
     tx.account, JSON.stringify(tx.raw)],
  )
  return (res.rowCount ?? 0) > 0
}

async function advanceWatermark(ledgerIndex: number) {
  await pool.query(
    `update sync_state
        set last_ingested_ledger = greatest(last_ingested_ledger, $1),
            updated_at = now()
      where id = 1`,
    [ledgerIndex],
  )
}

async function readWatermark(): Promise<number> {
  const [row] = await query<{ last_ingested_ledger: string }>(
    `select last_ingested_ledger from sync_state where id = 1`,
  )
  return Number(row?.last_ingested_ledger ?? 0)
}

/**
 * Page through account_tx for one account from `fromLedger` onward.
 * Returns how many NEW rows were written (duplicates are expected
 * and harmless — accounts share transactions).
 */
async function backfillAccount(
  client: Client, account: string, fromLedger: number,
): Promise<{ written: number; seen: number; maxLedger: number }> {
  let marker: any = undefined
  let written = 0
  let seen = 0
  let maxLedger = fromLedger

  for (let page = 0; page < 50; page++) {
    const res: any = await client.request({
      command: 'account_tx',
      account,
      ledger_index_min: fromLedger > 0 ? fromLedger : -1,
      ledger_index_max: -1,
      binary: false,
      forward: true,
      limit: 200,
      ...(marker ? { marker } : {}),
    })

    for (const entry of res.result.transactions ?? []) {
      if (entry.validated === false) continue
      const tx = normalize(entry)
      if (!tx) continue
      seen++
      if (await store(tx)) written++
      if (tx.ledgerIndex > maxLedger) maxLedger = tx.ledgerIndex
    }

    marker = res.result.marker
    if (!marker) break
  }

  return { written, seen, maxLedger }
}

export async function runIngest(opts: { once?: boolean } = {}) {
  const accounts = await watchedAccounts()
  if (accounts.length === 0) {
    console.log('no accounts to watch — seed an asset or investor first')
    return
  }

  console.log(`watching ${accounts.length} account(s)`)
  const client = await connect()

  // ---- 1. subscribe FIRST, buffer what arrives -------------------
  const buffer: NormalizedTx[] = []
  let live = false

  client.on('transaction', async (msg: any) => {
    const tx = normalize(msg)
    if (!tx) return
    if (live) {
      if (await store(tx)) {
        console.log(`  live  ${tx.txType.padEnd(22)} ${tx.txResult}  ${tx.hash.slice(0, 12)}`)
      }
      await advanceWatermark(tx.ledgerIndex)
    } else {
      buffer.push(tx)
    }
  })

  await client.request({ command: 'subscribe', accounts })
  console.log('subscribed, buffering')

  // ---- 2 & 3. watermark, then backfill ---------------------------
  const from = await readWatermark()
  console.log(`backfilling from ledger ${from || 'genesis'}`)

  let totalWritten = 0
  let maxLedger = from
  for (const account of accounts) {
    const r = await backfillAccount(client, account, from)
    totalWritten += r.written
    if (r.maxLedger > maxLedger) maxLedger = r.maxLedger
    console.log(`  ${account}  ${r.written} new / ${r.seen} seen`)
  }
  console.log(`backfill complete: ${totalWritten} new events`)

  // ---- 4. drain the buffer ---------------------------------------
  let drained = 0
  for (const tx of buffer) {
    if (await store(tx)) drained++
    if (tx.ledgerIndex > maxLedger) maxLedger = tx.ledgerIndex
  }
  if (buffer.length) {
    console.log(`drained buffer: ${drained} new / ${buffer.length} buffered`)
  }
  buffer.length = 0

  if (maxLedger > 0) await advanceWatermark(maxLedger)

  // ---- 5. go live ------------------------------------------------
  if (opts.once) {
    await client.disconnect()
    return
  }

  live = true
  console.log('live. ctrl-c to stop.\n')
}

// run directly: `npm run ingest`
if (import.meta.url === `file://${process.argv[1]}`) {
  const once = process.argv.includes('--once')
  await runIngest({ once })
  if (once) {
    await pool.end()
    process.exit(0)
  }
}
