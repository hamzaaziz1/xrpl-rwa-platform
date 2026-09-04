/**
 * The intent worker.
 *
 * Ties the three phases together. Runs continuously:
 *
 *   1. pick up anything 'pending' and submit it
 *   2. resolve anything 'submitted'
 *   3. sleep, repeat
 *
 * Deliberately a separate process from the API. The API records intents
 * and returns immediately; this moves them through their lifecycle. If
 * the API dies mid-request, the intent survives and this picks it up —
 * which is the entire reason for recording intent before acting.
 *
 * Run standalone:
 *   npm run worker           -- loop forever
 *   npm run worker -- --once -- one pass and exit
 */
import type { Client } from 'xrpl'
import { connect } from '../xrpl-client.js'
import { pool, query } from '../db/pool.js'
import { submit, type IntentRow } from './submit.js'
import { resolveAll } from './resolve.js'

const POLL_MS = 2_000

/** Submit every pending intent. Serial on purpose — see below. */
async function submitPending(client: Client, verbose = false): Promise<number> {
  const pending = await query<IntentRow>(
    `select * from intents where status = 'pending' order by created_at`,
  )

  let n = 0
  for (const intent of pending) {
    // Serial, not parallel. Sequence numbers must be used in order, and
    // while allocation is locked, SUBMISSION order still matters: the
    // ledger rejects a transaction whose sequence arrives before its
    // predecessor. Parallel submission from one account produces
    // tefPAST_SEQ under load.
    try {
      await submit(client, intent.intent_id)
      n++
      if (verbose) console.log(`  submitted  ${intent.kind}`)
    } catch (e: any) {
      if (verbose) console.log(`  submit failed  ${intent.kind}: ${e?.message ?? e}`)
    }
  }
  return n
}

export async function tick(client: Client, verbose = false) {
  const submitted = await submitPending(client, verbose)
  const counts = await resolveAll(client, { verbose })
  return { submitted, ...counts }
}

export async function runWorker(opts: { once?: boolean } = {}) {
  const client = await connect()
  console.log('intent worker started')

  if (opts.once) {
    const r = await tick(client, true)
    console.log(r)
    await client.disconnect()
    return r
  }

  let stopping = false
  process.on('SIGINT', () => { stopping = true })

  while (!stopping) {
    try {
      const r = await tick(client, false)
      if (r.submitted || r.confirmed || r.failed || r.expired) {
        console.log(
          `submitted ${r.submitted}  confirmed ${r.confirmed}  ` +
          `failed ${r.failed}  expired ${r.expired}  pending ${r.pending}`,
        )
      }
    } catch (e: any) {
      console.error('worker tick failed:', e?.message ?? e)
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }

  console.log('\nworker stopping')
  await client.disconnect()
  await pool.end()
  process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runWorker({ once: process.argv.includes('--once') })
  if (process.argv.includes('--once')) {
    await pool.end()
    process.exit(0)
  }
}
