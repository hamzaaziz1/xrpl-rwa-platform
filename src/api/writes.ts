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
        `select intent_id, kind, actor, status, tx_hash, engine_result,
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
        idempotencyKey: `approve:${req.params.id}`,
      })

      // Deliberately NOT writing an optimistic 'approving' status here.
      // In-flight state lives in `intents`; kyc_status is derived from
      // the credential projection once the ledger confirms. Writing it
      // early would be the registry claiming a state the ledger has not
      // reached — the exact drift this system exists to prevent.

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
