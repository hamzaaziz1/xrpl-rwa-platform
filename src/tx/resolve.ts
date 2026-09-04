/**
 * Intent resolution.
 *
 * Asks the ledger what actually happened to submitted intents, and
 * closes them out. This is the half of the write path that makes the
 * async design honest — without it you have fire-and-forget, which is
 * worse than blocking.
 *
 * For each submitted intent, exactly one of these is true:
 *
 *   - it validated successfully              -> confirmed
 *   - it validated with a tec/tem code       -> failed  (it landed, it failed)
 *   - its LastLedgerSequence has passed      -> expired (definitively dead)
 *   - none of the above yet                  -> leave it alone, check again
 *
 * The third case is the one that makes this tractable. On XRPL, once
 * LastLedgerSequence passes without validation, the transaction can
 * never apply. There is no mempool it might resurface from. So expired
 * is a FINAL state and retrying is safe.
 *
 * On a chain with a mempool you cannot say that, which is why retry
 * logic there is so much harder.
 */
import type { Client } from 'xrpl'
import { pool, query } from '../db/pool.js'
import { resyncSequence } from './sequences.js'
import type { IntentRow } from './submit.js'

/**
 * Ask xrpl-why what a failure actually means, so the UI can show a
 * reason instead of a tec code. Best-effort: a diagnosis failing must
 * never stop an intent from resolving.
 */
async function diagnose(
  client: Client, code: string, intent: IntentRow,
): Promise<{ reason: string | null; fix: string | null }> {
  try {
    const { explain } = await import('xrpl-why')
    const p = intent.params

    const context =
      intent.kind === 'token_issue'
        ? {
            kind: 'payment' as const,
            account: intent.actor,
            destination: p.destination,
            amount: {
              currency: p.currency,
              issuer: intent.actor,
              value: String(p.value),
            },
          }
        : undefined

    const why = await explain(client, code, context)
    const first = why.findings?.[0]
    return {
      reason: first?.reason ?? why.summary ?? null,
      fix: first?.fix ?? null,
    }
  } catch {
    return { reason: null, fix: null }
  }
}

/**
 * Resolve every intent currently in 'submitted'.
 * Returns a count of what moved where.
 */
export async function resolveAll(
  client: Client, opts: { verbose?: boolean } = {},
): Promise<{ confirmed: number; failed: number; expired: number; pending: number }> {
  const open = await query<IntentRow>(
    `select * from intents where status = 'submitted' order by submitted_at`,
  )

  const counts = { confirmed: 0, failed: 0, expired: 0, pending: 0 }
  if (open.length === 0) return counts

  const currentLedger = await client.getLedgerIndex()

  for (const intent of open) {
    if (!intent.tx_hash) continue

    let validated: any = null
    try {
      const res: any = await client.request({
        command: 'tx',
        transaction: intent.tx_hash,
      } as any)
      if (res.result?.validated) validated = res.result
    } catch {
      // txnNotFound is expected while a transaction is still in flight.
      validated = null
    }

    // ---- validated: we know the outcome -------------------------
    if (validated) {
      const code = validated.meta?.TransactionResult ?? 'unknown'
      const ledgerIndex = validated.ledger_index ?? null

      if (code === 'tesSUCCESS') {
        await pool.query(
          `update intents
              set status = 'confirmed', engine_result = $2,
                  validated_ledger = $3, resolved_at = now()
            where intent_id = $1`,
          [intent.intent_id, code, ledgerIndex],
        )
        counts.confirmed++
        if (opts.verbose) console.log(`  confirmed  ${intent.kind}  ${code}`)
      } else {
        const { reason, fix } = await diagnose(client, code, intent)
        await pool.query(
          `update intents
              set status = 'failed', engine_result = $2,
                  validated_ledger = $3, failure_reason = $4,
                  failure_fix = $5, resolved_at = now()
            where intent_id = $1`,
          [intent.intent_id, code, ledgerIndex, reason, fix],
        )
        counts.failed++
        if (opts.verbose) {
          console.log(`  failed     ${intent.kind}  ${code}`)
          if (reason) console.log(`             ${reason}`)
        }
      }
      continue
    }

    // ---- not validated, deadline passed: definitively dead -------
    if (intent.last_ledger_seq && currentLedger > intent.last_ledger_seq) {
      await pool.query(
        `update intents
            set status = 'expired', engine_result = 'LastLedgerSequence passed',
                resolved_at = now()
          where intent_id = $1`,
        [intent.intent_id],
      )
      // the sequence was never consumed on-ledger; our counter is ahead
      await resyncSequence(client, intent.actor)
      counts.expired++
      if (opts.verbose) {
        console.log(`  expired    ${intent.kind}  (ledger ${currentLedger} > ${intent.last_ledger_seq})`)
      }
      continue
    }

    // ---- still in flight ----------------------------------------
    counts.pending++
  }

  if (opts.verbose) {
    console.log(
      `\nresolved: ${counts.confirmed} confirmed, ${counts.failed} failed, ` +
      `${counts.expired} expired, ${counts.pending} still pending\n`,
    )
  }
  return counts
}

/** Poll until nothing is left in flight, or the budget runs out. */
export async function resolveUntilSettled(
  client: Client, opts: { timeoutMs?: number; intervalMs?: number; verbose?: boolean } = {},
) {
  const timeout = opts.timeoutMs ?? 60_000
  const interval = opts.intervalMs ?? 3_000
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    const counts = await resolveAll(client, opts)
    if (counts.pending === 0) return counts
    await new Promise(r => setTimeout(r, interval))
  }

  if (opts.verbose) console.log('timed out with intents still in flight')
  return resolveAll(client, opts)
}
