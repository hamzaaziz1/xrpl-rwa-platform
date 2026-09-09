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

/**
 * Compare the credential projection against the ledger.
 *
 * Added after a real failure: Carol's registry row said "approved"
 * while the ledger held an unaccepted credential, meaning she was not
 * a domain member and could not trade. Nothing detected it, because
 * the reconciler only checked balances.
 */
async function reconcileCredentials(client: any): Promise<Finding[]> {
  const out: Finding[] = []

  const rows = await query<{
    subject: string; issuer: string; credential_type: string
    accepted_at: string | null; revoked_at: string | null
  }>(`select subject, issuer, credential_type, accepted_at, revoked_at
        from credentials`)

  const LSF_ACCEPTED = 0x00010000

  for (const row of rows) {
    let onLedger: any = null
    try {
      const res: any = await client.request({
        command: 'account_objects',
        account: row.subject,
        type: 'credential',
        ledger_index: 'validated',
      })
      onLedger = (res.result.account_objects ?? []).find(
        (o: any) => o.Issuer === row.issuer &&
                    o.CredentialType === row.credential_type,
      ) ?? null
    } catch {
      continue
    }

    const projectedLive = !row.revoked_at
    const ledgerLive = onLedger !== null

    if (projectedLive !== ledgerLive) {
      out.push({
        currency: 'CREDENTIAL', issuer: row.issuer, account: row.subject,
        ledgerValue: ledgerLive ? 1 : 0,
        registryValue: projectedLive ? 1 : 0,
        severity: 'critical',
        note: ledgerLive
          ? 'ledger has a credential the projection records as revoked'
          : 'projection has a credential the ledger does not',
      })
      continue
    }

    if (!ledgerLive) continue

    const ledgerAccepted = (onLedger.Flags & LSF_ACCEPTED) !== 0
    const projectedAccepted = row.accepted_at !== null

    if (ledgerAccepted !== projectedAccepted) {
      out.push({
        currency: 'CREDENTIAL', issuer: row.issuer, account: row.subject,
        ledgerValue: ledgerAccepted ? 1 : 0,
        registryValue: projectedAccepted ? 1 : 0,
        severity: 'critical',
        note: 'acceptance state disagrees — an unaccepted credential grants no domain membership',
      })
    }
  }

  return out
}

/**
 * Compare the offer projection against the ledger.
 *
 * Added after a real miss: two offers placed through the UI confirmed on
 * the ledger and never arrived over the websocket subscription. They
 * were invisible until an unrelated restart backfilled them, and nothing
 * would have reported the gap.
 *
 * A periodic sweep now heals that class of failure. This detects it.
 */
async function reconcileOffers(client: any): Promise<Finding[]> {
  const out: Finding[] = []

  const accounts = await query<{ account: string }>(
    `select distinct account from offers where closed_ledger is null
     union
     select account from investors where account is not null`,
  )

  for (const { account } of accounts) {
    if (!account) continue

    let live: Set<number>
    try {
      const res: any = await client.request({
        command: 'account_offers',
        account,
        ledger_index: 'validated',
      })
      live = new Set((res.result.offers ?? []).map((o: any) => Number(o.seq)))
    } catch {
      continue
    }

    const projected = await query<{ sequence: number }>(
      `select sequence from offers
        where account = $1 and closed_ledger is null`,
      [account],
    )
    const projectedSeqs = new Set(projected.map(r => Number(r.sequence)))

    for (const seq of projectedSeqs) {
      if (!live.has(seq)) {
        out.push({
          currency: 'OFFER', issuer: String(seq), account,
          ledgerValue: 0, registryValue: 1,
          severity: 'critical',
          note: `projection shows offer ${seq} as open; the ledger does not have it`,
        })
      }
    }

    for (const seq of live) {
      if (!projectedSeqs.has(seq)) {
        out.push({
          currency: 'OFFER', issuer: String(seq), account,
          ledgerValue: 1, registryValue: 0,
          severity: 'critical',
          note: `ledger has open offer ${seq} the projection never recorded — likely a missed event`,
        })
      }
    }
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

    findings.push(...await reconcileCredentials(client))
    findings.push(...await reconcileOffers(client))

    if (record) {
      // Close out anything that was drifting and no longer is. Without
      // this, a repaired finding sits unresolved forever and the panel
      // shows a permanent alert — which trains people to ignore it.
      const stillDrifting = findings.map(f => `${f.currency}|${f.issuer}|${f.account}`)
      await pool.query(
        `update reconciliation_findings
            set resolved_at = now()
          where resolved_at is null
            and (currency || '|' || issuer || '|' || account) <> all($1::text[])`,
        [stillDrifting],
      )

      // Only record a finding if this (currency, issuer, account) isn't
      // already open. Re-running the reconciler shouldn't pile up
      // duplicates of the same unresolved problem.
      for (const f of findings) {
        await pool.query(
          `insert into reconciliation_findings
             (currency, issuer, account, ledger_value, registry_value, severity)
           select $1, $2, $3, $4, $5, $6
            where not exists (
              select 1 from reconciliation_findings
               where resolved_at is null
                 and currency = $1 and issuer = $2 and account = $3
            )`,
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
