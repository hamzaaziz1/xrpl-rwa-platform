import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { query, pool } from '../db/pool.js'
import { registerWrites } from './writes.js'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const app = Fastify({ logger: false })
await app.register(cors, { origin: true })

// Several endpoints take no body. A client that sets content-type:
// application/json with an empty body would otherwise get a 400 from
// the parser before the handler ever runs.
app.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (_req, body: string, done) => {
    if (!body || body.trim() === '') return done(null, {})
    try { done(null, JSON.parse(body)) }
    catch (err) { done(err as Error, undefined) }
  },
)

registerWrites(app)

// ---------------------------------------------------------------
// assets
// ---------------------------------------------------------------

app.get('/api/assets', async () => {
  // Explicit column list, never `a.*`. The assets table holds
  // `issuer_seed`, and a wildcard select puts a private key on a public
  // endpoint. Testnet keys controlling nothing, but the habit is what
  // matters.
  return query(`
    select a.asset_id, a.currency, a.issuer, a.title, a.external_ref,
           a.document_hash, a.jurisdiction, a.total_units, a.domain_id,
           a.status, a.created_at,
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
      select h.account, h.balance, h.frozen, h.last_ledger_index,
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
  // kyc_status is DERIVED from the credential projection, not read from
  // the investors table. The stored column can disagree with the ledger;
  // the projection cannot. See MANUAL section 10.
  //
  // 'issued' is a real state, not a synonym for approved: an issued but
  // unaccepted credential grants no domain membership, so the holder
  // cannot trade.
  return query(`
    select i.investor_id, i.legal_name, i.email, i.account,
           i.kyc_submitted,
           c.issued_at   as kyc_issued,
           c.accepted_at as credential_accepted_at,
           c.revoked_at  as kyc_revoked,
           case
             when c.revoked_at  is not null then 'revoked'
             when c.accepted_at is not null then 'approved'
             when c.issued_at   is not null then 'issued'
             else 'pending'
           end as kyc_status
      from investors i
      left join credentials c on c.subject = i.account
     where i.kyc_status <> 'system'
     order by i.investor_id
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

// ---------------------------------------------------------------
// Serve the built frontend from the same origin as the API.
//
// One service, one domain, and the client and API can never disagree
// about versions. Registered last so it cannot shadow API routes.
// ---------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, '../../public')

await app.register(fastifyStatic, { root: publicDir })

// SPA fallback: anything not under /api serves index.html, so
// client-side routing survives a refresh.
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api')) {
    return reply.code(404).send({ error: 'not found' })
  }
  return reply.sendFile('index.html')
})

const port = Number(process.env.PORT ?? 3001)
await app.listen({ port, host: '0.0.0.0' })
console.log(`api on http://localhost:${port}`)

process.on('SIGINT', async () => {
  await app.close()
  await pool.end()
  process.exit(0)
})
