import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { query, pool } from '../db/pool.js'
import { registerWrites } from './writes.js'

const app = Fastify({ logger: false })
await app.register(cors, { origin: true })

registerWrites(app)

// ---------------------------------------------------------------
// assets
// ---------------------------------------------------------------

app.get('/api/assets', async () => {
  return query(`
    select a.*,
           coalesce(-i.balance, 0) as units_outstanding,
           (select count(*) from holdings h
             where h.currency = a.currency
               and h.issuer = a.issuer
               and h.account <> a.issuer
               and h.balance > 0) as holder_count
      from assets a
      left join holdings i
        on i.currency = a.currency
       and i.issuer = a.issuer
       and i.account = a.issuer
     order by a.asset_id
  `)
})

// ---------------------------------------------------------------
// holdings for one asset (issuer row excluded — it's the negative
// mirror of everything else, not a holder)
// ---------------------------------------------------------------

app.get<{ Params: { assetId: string } }>(
  '/api/assets/:assetId/holdings',
  async (req, reply) => {
    const [asset] = await query<{ currency: string; issuer: string }>(
      `select currency, issuer from assets where asset_id = $1`,
      [req.params.assetId],
    )
    if (!asset) return reply.code(404).send({ error: 'unknown asset' })

    return query(`
      select h.account, h.balance, h.last_ledger_index,
             i.investor_id, i.legal_name, i.kyc_status
        from holdings h
        left join investors i on i.account = h.account
       where h.currency = $1
         and h.issuer = $2
         and h.account <> $2
       order by h.balance desc
    `, [asset.currency, asset.issuer])
  },
)

// ---------------------------------------------------------------
// investors. system rows (the issuer and kyc accounts) are stored
// in the same table for now; they are not investors and are hidden.
// ---------------------------------------------------------------

app.get('/api/investors', async () => {
  return query(`
    select investor_id, legal_name, email, account, kyc_status,
           kyc_submitted, kyc_approved, credential_accepted_at
      from investors
     where kyc_status <> 'system'
     order by investor_id
  `)
})

// ---------------------------------------------------------------
// reconciliation
// ---------------------------------------------------------------

app.get('/api/reconciliation', async () => {
  const findings = await query(`
    select * from reconciliation_findings
     where resolved_at is null
     order by detected_at desc
     limit 100
  `)

  const [state] = await query(`
    select last_ingested_ledger, last_projected_ledger, updated_at
      from sync_state where id = 1
  `)

  return {
    status: findings.length === 0 ? 'clean' : 'drift',
    findingCount: findings.length,
    findings,
    sync: state,
  }
})

// ---------------------------------------------------------------
// the event log, newest first. this is the audit trail.
// ---------------------------------------------------------------

app.get<{ Querystring: { limit?: string } }>('/api/events', async (req) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200)
  return query(`
    select tx_hash, ledger_index, tx_index, tx_type, tx_result,
           account, ingested_at
      from ledger_events
     order by ledger_index desc, tx_index desc
     limit $1
  `, [limit])
})

app.get('/api/health', async () => ({ ok: true }))

const port = Number(process.env.PORT ?? 3001)
await app.listen({ port, host: '0.0.0.0' })
console.log(`api on http://localhost:${port}`)

process.on('SIGINT', async () => {
  await app.close()
  await pool.end()
  process.exit(0)
})
