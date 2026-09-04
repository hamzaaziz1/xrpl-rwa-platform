/**
 * Reconciler: projection vs live ledger.
 *
 * Reads trust line balances directly from the ledger and compares them
 * against `holdings`. Any divergence is recorded in
 * `reconciliation_findings`.
 *
 * WHY THIS EXISTS, given the projection should already be correct:
 *
 *   1. The projection logic can be wrong. It was — the issuer-side rows
 *      were split across one row per holder until canonicalization was
 *      added. Balances looked plausible. Nobody would have noticed.
 *
 *   2. Events can be missed. A dropped websocket, a backfill gap, or an
 *      account added to the registry after transactions already happened
 *      against it. The log is only complete if ingest never failed.
 *
 *   3. The ledger is the authority. Verifying against it is the only real
 *      check; everything else is checking the database against itself.
 *
 * Anyone can write a projection. Operating one means assuming it is wrong
 * and building the thing that tells you when.
 */
import type { Client } from 'xrpl'
import { connect } from '../xrpl-client.js'
import { pool, query } from '../db/pool.js'

/** Below this, treat as floating-point noise rather than real drift. */
const EPSILON = 1e-9

export interface Finding {
  currency: string
  issuer: string
  account: string
  ledgerValue: number | null
  registryValue: number | null
  severity: 'info' | 'warning' | 'critical'
  note: string
}

function severityFor(ledger: number | null, registry: number | null): Finding['severity'] {
  if (ledger === null || registry === null) return 'critical'
  const diff = Math.abs(ledger - registry)
  const scale = Math.max(Math.abs(ledger), Math.abs(registry), 1)
  if (diff / scale > 0.01) return 'critical'
  if (diff > EPSILON) return 'warning'
  return 'info'
}

/**
 * Live balances for one account, keyed "CURRENCY|ISSUER".
 *
 * Always reads `validated`. Reading `current` would compare against a
 * ledger that hasn't been finalised, producing phantom drift that
 * disappears on the next run — the worst kind of alert.
 */
async function ledgerBalances(
  client: Client, account: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()

  let marker: any = undefined
  for (let page = 0; page < 20; page++) {
    const res: any = await client.request({
      command: 'account_lines',
      account,
      ledger_index: 'validated',
      ...(marker ? { marker } : {}),
    })

    for (const line of res.result.lines ?? []) {
      // `account` on a trust line row is the COUNTERPARTY, not the
      // account queried. For a holder that counterparty is the issuer.
      out.set(`${line.currency}|${line.account}`, Number(line.balance))
    }

    marker = res.result.marker
    if (!marker) break
  }

  return out
}

export async function reconcile(opts: { verbose?: boolean; record?: boolean } = {}) {
  const record = opts.record !== false
  const client = await connect()
  const findings: Finding[] = []

  try {
    // every account we have an opinion about, from either side
    const accounts = await query<{ account: string }>(`
      select distinct account from holdings
      union
      select issuer as account from assets
      union
      select account from investors where account is not null
    `)

    const issuers = new Set(
      (await query<{ issuer: string }>(`select distinct issuer from assets`))
        .map(r => r.issuer),
    )

    for (const { account } of accounts) {
      if (!account) continue

      const live = await ledgerBalances(client, account)

      const projected = await query<{
        currency: string; issuer: string; balance: string
      }>(
        `select currency, issuer, balance from holdings where account = $1`,
        [account],
      )

      const seen = new Set<string>()

      // --- projection says something; does the ledger agree? ---
      for (const row of projected) {
        const registryValue = Number(row.balance)

        // For an issuer, the projection stores one canonical row
        // (issuer = itself) while the ledger has one line per holder.
        // Sum the ledger side to compare like with like.
        let ledgerValue: number | null
        if (issuers.has(account) && row.issuer === account) {
          let total = 0
          let found = false
          for (const [key, value] of live) {
            if (key.startsWith(`${row.currency}|`)) { total += value; found = true }
          }
          ledgerValue = found ? total : null
          for (const key of live.keys()) {
            if (key.startsWith(`${row.currency}|`)) seen.add(key)
          }
        } else {
          const key = `${row.currency}|${row.issuer}`
          seen.add(key)
          ledgerValue = live.has(key) ? live.get(key)! : null
        }

        const severity = severityFor(ledgerValue, registryValue)
        if (severity === 'info') continue

        findings.push({
          currency: row.currency,
          issuer: row.issuer,
          account,
          ledgerValue,
          registryValue,
          severity,
          note: ledgerValue === null
            ? 'projection has a balance the ledger does not'
            : `ledger ${ledgerValue} vs projection ${registryValue}`,
        })
      }

      // --- ledger says something the projection never heard about ---
      for (const [key, value] of live) {
        if (seen.has(key)) continue
        if (Math.abs(value) < EPSILON) continue

        const [currency, issuer] = key.split('|')
        findings.push({
          currency, issuer, account,
          ledgerValue: value,
          registryValue: null,
          severity: 'critical',
          note: 'ledger has a balance the projection never recorded — likely a missed event',
        })
      }
    }

    if (record) {
      for (const f of findings) {
        await pool.query(
          `insert into reconciliation_findings
             (currency, issuer, account, ledger_value, registry_value, severity)
           values ($1, $2, $3, $4, $5, $6)`,
          [f.currency, f.issuer, f.account, f.ledgerValue, f.registryValue, f.severity],
        )
      }
    }

    if (opts.verbose) {
      if (findings.length === 0) {
        console.log(`\nreconciled ${accounts.length} accounts — no drift\n`)
      } else {
        console.log(`\n${findings.length} finding(s):\n`)
        for (const f of findings) {
          console.log(`  [${f.severity.toUpperCase()}] ${f.account.slice(0, 12)}... ${f.currency}`)
          console.log(`    ${f.note}\n`)
        }
      }
    }

    return findings
  } finally {
    await client.disconnect()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await reconcile({ verbose: true })
  await pool.end()
}
