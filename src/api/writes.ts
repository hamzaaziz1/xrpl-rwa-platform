/**
 * Write endpoints.
 *
 * Every one of these records an INTENT and returns 202 immediately.
 * Nothing here touches the ledger — the worker does that.
 *
 * The response carries an intent id. Clients poll GET /api/intents/:id
 * until status leaves 'pending'/'submitted'.
 *
 * Why 202 and not 200: the request has been accepted, not completed.
 * Returning 200 would claim an outcome we do not have yet.
 */
import type { FastifyInstance } from 'fastify'
import { query } from '../db/pool.js'
import { create, type IntentKind } from '../tx/submit.js'
import { connect } from '../xrpl-client.js'
import { createAsset } from '../assets/create.js'
import { onboardInvestor } from '../assets/onboard.js'

const toHex = (s: string) =>
  Buffer.from(s, 'utf8').toString('hex').toUpperCase()

const KYC_CREDENTIAL = toHex('KYC')

async function assetOr404(assetId: string) {
  const [asset] = await query<{ currency: string; issuer: string }>(
    `select currency, issuer from assets where asset_id = $1`, [assetId],
  )
  return asset ?? null
}

async function systemAccount(role: 'sys-issuer' | 'sys-kyc') {
  const [row] = await query<{ account: string }>(
    `select account from investors where investor_id = $1`, [role],
  )
  if (!row) throw new Error(`system account ${role} not seeded`)
  return row.account
}

/** Accept an intent and return 202 with a poll URL. */
function accepted(reply: any, intent: { intent_id: string; status: string }) {
  return reply.code(202).send({
    intentId: intent.intent_id,
    status: intent.status,
    poll: `/api/intents/${intent.intent_id}`,
  })
}

export function registerWrites(app: FastifyInstance) {

  // ---- poll an intent -------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/intents/:id',
    async (req, reply) => {
      const [intent] = await query(
        `select intent_id, kind, actor, params, status, tx_hash,
                engine_result, failure_reason, failure_fix,
                created_at, submitted_at, resolved_at, attempts
           from intents where intent_id = $1`,
        [req.params.id],
      )
      if (!intent) return reply.code(404).send({ error: 'unknown intent' })
      return intent
    },
  )

  // ---- recent intents, for the activity feed --------------------
  app.get<{ Querystring: { limit?: string } }>(
    '/api/intents',
    async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 30), 100)
      return query(
        `select intent_id, kind, actor, params, status, tx_hash, engine_result,
                failure_reason, created_at, resolved_at
           from intents order by created_at desc limit $1`,
        [limit],
      )
    },
  )

  // ---- approve KYC: issue a credential on-ledger ----------------
  app.post<{ Params: { id: string } }>(
    '/api/investors/:id/approve',
    async (req, reply) => {
      const [investor] = await query<{ account: string; kyc_status: string }>(
        `select account, kyc_status from investors where investor_id = $1`,
        [req.params.id],
      )
      if (!investor) return reply.code(404).send({ error: 'unknown investor' })
      if (!investor.account) {
        return reply.code(400).send({ error: 'investor has no account' })
      }

      const kyc = await systemAccount('sys-kyc')

      const intent = await create({
        kind: 'credential_issue',
        actor: kyc,
        params: { subject: investor.account, credentialType: KYC_CREDENTIAL },
        // Keyed on the credential that doesn't exist yet rather than a
        // fixed string. A constant key means an investor can be approved
        // exactly once ever — a revoke followed by re-approval would
        // silently return the old intent.
        idempotencyKey: `approve:${req.params.id}:${Date.now()}`,
      })

      // Deliberately NOT writing an optimistic 'approving' status here.
      // In-flight state lives in `intents`; kyc_status is derived from
      // the credential projection once the ledger confirms. Writing it
      // early would be the registry claiming a state the ledger has not
      // reached — the exact drift this system exists to prevent.

      return accepted(reply, intent)
    },
  )

  // ---- investor accepts their own credential --------------------
  // The investor signs this, not the issuer. An issued but unaccepted
  // credential grants no domain membership, so this is the step that
  // actually makes someone eligible to trade.
  app.post<{ Params: { id: string } }>(
    '/api/investors/:id/accept-credential',
    async (req, reply) => {
      const [investor] = await query<{ account: string }>(
        `select account from investors where investor_id = $1`, [req.params.id],
      )
      if (!investor?.account) {
        return reply.code(404).send({ error: 'unknown investor' })
      }

      const [cred] = await query<{ issuer: string; credential_type: string }>(
        `select issuer, credential_type from credentials
          where subject = $1 and accepted_at is null and revoked_at is null
          limit 1`,
        [investor.account],
      )
      if (!cred) {
        return reply.code(400).send({
          error: 'no unaccepted credential for this investor',
        })
      }

      const intent = await create({
        kind: 'credential_accept',
        actor: investor.account,
        params: { issuer: cred.issuer, credentialType: cred.credential_type },
        idempotencyKey: `accept:${req.params.id}:${cred.issuer}`,
      })

      return accepted(reply, intent)
    },
  )

  // ---- revoke KYC: delete the credential ------------------------
  app.post<{ Params: { id: string } }>(
    '/api/investors/:id/revoke',
    async (req, reply) => {
      const [investor] = await query<{ account: string }>(
        `select account from investors where investor_id = $1`, [req.params.id],
      )
      if (!investor?.account) {
        return reply.code(404).send({ error: 'unknown investor' })
      }

      const kyc = await systemAccount('sys-kyc')

      const intent = await create({
        kind: 'credential_revoke',
        actor: kyc,
        params: { subject: investor.account, credentialType: KYC_CREDENTIAL },
        idempotencyKey: `revoke:${req.params.id}:${Date.now()}`,
      })

      return accepted(reply, intent)
    },
  )

  // ---- create an asset -------------------------------------------
  //
  // Synchronous, unlike every other write here. See assets/create.ts for
  // why: four ordered transactions where a partial result is permanently
  // broken rather than retryable.
  app.post<{
    Body: {
      assetId: string; currency: string; title: string
      externalRef?: string; jurisdiction?: string; totalUnits: number
    }
  }>(
    '/api/assets',
    async (req, reply) => {
      const client = await connect()
      try {
        const result = await createAsset(client, req.body)
        return reply.code(201).send(result)
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message ?? String(e) })
      } finally {
        await client.disconnect()
      }
    },
  )

  // ---- onboard an investor to an asset ---------------------------
  app.post<{
    Params: { assetId: string }
    Body: { investorId: string; units?: string; limit?: string }
  }>(
    '/api/assets/:assetId/onboard',
    async (req, reply) => {
      const client = await connect()
      try {
        const result = await onboardInvestor(client, {
          assetId: req.params.assetId,
          investorId: req.body?.investorId,
          units: req.body?.units,
          limit: req.body?.limit,
        })
        return reply.code(201).send(result)
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message ?? String(e) })
      } finally {
        await client.disconnect()
      }
    },
  )

  // ---- place a permissioned offer --------------------------------
  //
  // Signed by the investor. Membership is checked here rather than
  // letting the ledger reject it: the ledger's answer is correct but
  // takes eight seconds and arrives as tecNO_PERMISSION.
  app.post<{
    Params: { assetId: string }
    Body: { investorId: string; side: 'ask' | 'bid'; units: string; xrpDrops: string }
  }>(
    '/api/assets/:assetId/offers',
    async (req, reply) => {
      const [asset] = await query<{ currency: string; issuer: string; domain_id: string | null }>(
        `select currency, issuer, domain_id from assets where asset_id = $1`,
        [req.params.assetId],
      )
      if (!asset) return reply.code(404).send({ error: 'unknown asset' })

      const { investorId, side, units, xrpDrops } = req.body ?? ({} as any)
      if (!investorId || !side || !units || !xrpDrops) {
        return reply.code(400).send({ error: 'investorId, side, units and xrpDrops required' })
      }
      if (side !== 'ask' && side !== 'bid') {
        return reply.code(400).send({ error: "side must be 'ask' or 'bid'" })
      }
      if (Number(units) <= 0 || Number(xrpDrops) <= 0) {
        return reply.code(400).send({ error: 'units and xrpDrops must be positive' })
      }

      const [investor] = await query<{ account: string }>(
        `select account from investors where investor_id = $1`, [investorId],
      )
      if (!investor?.account) return reply.code(404).send({ error: 'unknown investor' })

      const [cred] = await query<{ accepted_at: string | null; revoked_at: string | null }>(
        `select accepted_at, revoked_at from credentials where subject = $1`,
        [investor.account],
      )
      if (!cred?.accepted_at || cred.revoked_at) {
        return reply.code(403).send({
          error: 'not a member of the permissioned domain — an accepted, unrevoked credential is required to trade',
        })
      }

      // A bid delivers units to the buyer, so they need an authorised
      // trust line first. Without this the ledger refuses with
      // tecNO_LINE eight seconds later — correct, but the buyer has no
      // idea they needed to be onboarded to this asset.
      if (side === 'bid') {
        const [line] = await query<{ frozen: boolean }>(
          `select frozen from holdings
            where currency = $1 and issuer = $2 and account = $3`,
          [asset.currency, asset.issuer, investor.account],
        )
        if (!line) {
          return reply.code(400).send({
            error: `no trust line for ${asset.currency} — this account must be onboarded to the asset before it can buy units`,
          })
        }
        if (line.frozen) {
          return reply.code(403).send({
            error: 'this holding is frozen and cannot receive units',
          })
        }
      }

      if (side === 'ask') {
        const [holding] = await query<{ balance: string; frozen: boolean }>(
          `select balance, frozen from holdings
            where currency = $1 and issuer = $2 and account = $3`,
          [asset.currency, asset.issuer, investor.account],
        )
        if (holding?.frozen) {
          return reply.code(403).send({ error: 'this holding is frozen and cannot be sold' })
        }
        if (Number(holding?.balance ?? 0) < Number(units)) {
          return reply.code(400).send({
            error: `insufficient units: holds ${holding?.balance ?? 0}, offered ${units}`,
          })
        }
      }

      const intent = await create({
        kind: 'offer_create',
        actor: investor.account,
        params: {
          side, units, xrpDrops,
          currency: asset.currency,
          issuer: asset.issuer,
          domainId: asset.domain_id,
        },
        idempotencyKey: `offer:${investor.account}:${Date.now()}`,
      })

      return accepted(reply, intent)
    },
  )

  // ---- cancel your own offer -------------------------------------
  app.post<{ Body: { investorId: string; sequence: number } }>(
    '/api/offers/cancel',
    async (req, reply) => {
      const { investorId, sequence } = req.body ?? ({} as any)
      if (!investorId || sequence == null) {
        return reply.code(400).send({ error: 'investorId and sequence required' })
      }

      const [investor] = await query<{ account: string }>(
        `select account from investors where investor_id = $1`, [investorId],
      )
      if (!investor?.account) return reply.code(404).send({ error: 'unknown investor' })

      const [offer] = await query(
        `select 1 from offers
          where account = $1 and sequence = $2 and closed_ledger is null`,
        [investor.account, sequence],
      )
      if (!offer) return reply.code(404).send({ error: 'no open offer with that sequence' })

      const intent = await create({
        kind: 'offer_cancel',
        actor: investor.account,
        params: { offerSequence: sequence },
        idempotencyKey: `cancel:${investor.account}:${sequence}`,
      })

      return accepted(reply, intent)
    },
  )

  // ---- the order book --------------------------------------------
  app.get<{ Params: { assetId: string } }>(
    '/api/assets/:assetId/book',
    async (req, reply) => {
      const [asset] = await query<{ currency: string; issuer: string }>(
        `select currency, issuer from assets where asset_id = $1`,
        [req.params.assetId],
      )
      if (!asset) return reply.code(404).send({ error: 'unknown asset' })

      const offers = await query(`
        select o.account, o.sequence, o.side, o.units, o.xrp_drops,
               o.created_ledger, i.legal_name, i.investor_id
          from offers o
          left join investors i on i.account = o.account
         where o.currency = $1 and o.issuer = $2 and o.closed_ledger is null
         order by o.side,
                  case when o.side = 'ask'
                       then o.xrp_drops / nullif(o.units, 0)
                       else -(o.xrp_drops / nullif(o.units, 0)) end
      `, [asset.currency, asset.issuer])

      return {
        asks: offers.filter((o: any) => o.side === 'ask'),
        bids: offers.filter((o: any) => o.side === 'bid'),
      }
    },
  )

  // ---- freeze / unfreeze a holder -------------------------------
  for (const action of ['freeze', 'unfreeze'] as const) {
    app.post<{ Params: { assetId: string }; Body: { holder: string } }>(
      `/api/assets/:assetId/${action}`,
      async (req, reply) => {
        const asset = await assetOr404(req.params.assetId)
        if (!asset) return reply.code(404).send({ error: 'unknown asset' })
        if (!req.body?.holder) {
          return reply.code(400).send({ error: 'holder required' })
        }

        const intent = await create({
          kind: action as IntentKind,
          actor: asset.issuer,
          params: { currency: asset.currency, holder: req.body.holder },
          idempotencyKey: `${action}:${req.body.holder}:${Date.now()}`,
        })

        return accepted(reply, intent)
      },
    )
  }

  // ---- clawback -------------------------------------------------
  app.post<{
    Params: { assetId: string }
    Body: { holder: string; value: string }
  }>(
    '/api/assets/:assetId/clawback',
    async (req, reply) => {
      const asset = await assetOr404(req.params.assetId)
      if (!asset) return reply.code(404).send({ error: 'unknown asset' })
      if (!req.body?.holder || !req.body?.value) {
        return reply.code(400).send({ error: 'holder and value required' })
      }

      const intent = await create({
        kind: 'clawback',
        actor: asset.issuer,
        params: {
          currency: asset.currency,
          holder: req.body.holder,
          value: String(req.body.value),
        },
        idempotencyKey: `clawback:${req.body.holder}:${Date.now()}`,
      })

      return accepted(reply, intent)
    },
  )

  // ---- issue more units to a holder -----------------------------
  app.post<{
    Params: { assetId: string }
    Body: { holder: string; value: string }
  }>(
    '/api/assets/:assetId/issue',
    async (req, reply) => {
      const asset = await assetOr404(req.params.assetId)
      if (!asset) return reply.code(404).send({ error: 'unknown asset' })
      if (!req.body?.holder || !req.body?.value) {
        return reply.code(400).send({ error: 'holder and value required' })
      }

      const intent = await create({
        kind: 'token_issue',
        actor: asset.issuer,
        params: {
          currency: asset.currency,
          destination: req.body.holder,
          value: String(req.body.value),
        },
        idempotencyKey: `issue:${req.body.holder}:${Date.now()}`,
      })

      return accepted(reply, intent)
    },
  )
}
