/**
 * Intent submission.
 *
 * Three phases, deliberately separated:
 *
 *   create()   record what we mean to do, return immediately
 *   submit()   build, sign, send. does NOT wait for validation.
 *   resolve()  ask the ledger what happened to submitted intents
 *
 * The separation is the point. Between submitting and knowing the
 * outcome there is a window where the process can die, the network can
 * drop, or the client can disconnect. If the only record of the attempt
 * lives in an in-flight HTTP request, that window loses transactions
 * silently.
 *
 * WHY THIS IS TRACTABLE ON XRPL:
 *
 * Every transaction carries LastLedgerSequence. Once that ledger closes
 * without the transaction being validated, it can NEVER apply. Not
 * "probably won't" — cannot. So an unresolved intent past its deadline
 * is definitively dead and safe to retry with a fresh sequence.
 *
 * On a chain with a mempool this is much harder: an unconfirmed
 * transaction might land an hour later, so retrying risks doing the
 * thing twice.
 */
import { Wallet, type Client } from 'xrpl'
import { pool, query } from '../db/pool.js'
import { allocateSequence, resyncSequence } from './sequences.js'

/** How many ledgers ahead to set the deadline. ~4s per ledger. */
const LEDGER_WINDOW = 10

export type IntentKind =
  | 'credential_issue'
  | 'credential_accept'
  | 'credential_revoke'
  | 'trustline_authorize'
  | 'token_issue'
  | 'freeze'
  | 'unfreeze'
  | 'clawback'

export interface CreateIntent {
  kind: IntentKind
  actor: string
  params: Record<string, any>
  idempotencyKey?: string
}

export interface IntentRow {
  intent_id: string
  kind: string
  actor: string
  params: any
  status: string
  tx_hash: string | null
  account_sequence: number | null
  last_ledger_seq: number | null
  engine_result: string | null
  failure_reason: string | null
  failure_fix: string | null
  attempts: number
}

/**
 * Record an intent. Nothing has touched the ledger yet.
 *
 * If an idempotency key is supplied and already exists, the existing
 * intent is returned unchanged — so a client retrying a request that
 * timed out doesn't cause the action to happen twice.
 */
export async function create(input: CreateIntent): Promise<IntentRow> {
  if (input.idempotencyKey) {
    const [existing] = await query<IntentRow>(
      `select * from intents where idempotency_key = $1`,
      [input.idempotencyKey],
    )
    if (existing) return existing
  }

  const [row] = await query<IntentRow>(
    `insert into intents (idempotency_key, kind, actor, params)
     values ($1, $2, $3, $4)
     returning *`,
    [input.idempotencyKey ?? null, input.kind, input.actor,
     JSON.stringify(input.params)],
  )
  return row
}

/** Look up the stored seed for an account. Testnet only — see MANUAL section 6. */
async function walletFor(account: string): Promise<Wallet> {
  const [row] = await query<{ seed: string }>(
    `select seed from investors where account = $1 and seed is not null`,
    [account],
  )
  if (!row) throw new Error(`no key material for ${account}`)
  return Wallet.fromSeed(row.seed)
}

/** Turn an intent's params into an unsigned transaction. */
function buildTx(intent: IntentRow): any {
  const p = intent.params

  switch (intent.kind) {
    case 'credential_issue':
      return {
        TransactionType: 'CredentialCreate',
        Account: intent.actor,
        Subject: p.subject,
        CredentialType: p.credentialType,
        ...(p.uri ? { URI: p.uri } : {}),
      }

    case 'credential_accept':
      // Submitted BY the subject, not the issuer. This is the point of
      // two-sided credentials: nobody can attach an attribute to your
      // account without your signature.
      return {
        TransactionType: 'CredentialAccept',
        Account: intent.actor,
        Issuer: p.issuer,
        CredentialType: p.credentialType,
      }

    case 'credential_revoke':
      return {
        TransactionType: 'CredentialDelete',
        Account: intent.actor,
        Subject: p.subject,
        CredentialType: p.credentialType,
      }

    case 'trustline_authorize':
      return {
        TransactionType: 'TrustSet',
        Account: intent.actor,
        LimitAmount: { currency: p.currency, issuer: p.holder, value: '0' },
        Flags: 0x00010000, // tfSetfAuth
      }

    case 'token_issue':
      return {
        TransactionType: 'Payment',
        Account: intent.actor,
        Destination: p.destination,
        Amount: { currency: p.currency, issuer: intent.actor, value: p.value },
      }

    case 'freeze':
      return {
        TransactionType: 'TrustSet',
        Account: intent.actor,
        LimitAmount: { currency: p.currency, issuer: p.holder, value: '0' },
        Flags: 0x00100000, // tfSetFreeze
      }

    case 'unfreeze':
      return {
        TransactionType: 'TrustSet',
        Account: intent.actor,
        LimitAmount: { currency: p.currency, issuer: p.holder, value: '0' },
        Flags: 0x00200000, // tfClearFreeze
      }

    case 'clawback':
      return {
        TransactionType: 'Clawback',
        Account: intent.actor,
        // NOTE: `issuer` here is the HOLDER. On a Clawback the issuer
        // names whose balance to reach into. Two-sided objects again.
        Amount: { currency: p.currency, issuer: p.holder, value: p.value },
      }

    default:
      throw new Error(`unknown intent kind: ${intent.kind}`)
  }
}

/**
 * Build, sign and send. Returns as soon as the ledger has ACCEPTED the
 * submission — not when it has validated it. Resolution happens later.
 */
export async function submit(client: Client, intentId: string): Promise<IntentRow> {
  const [intent] = await query<IntentRow>(
    `select * from intents where intent_id = $1`, [intentId],
  )
  if (!intent) throw new Error(`no such intent: ${intentId}`)
  if (intent.status !== 'pending') return intent

  const wallet = await walletFor(intent.actor)
  const sequence = await allocateSequence(client, intent.actor)

  const current = await client.getLedgerIndex()
  const lastLedgerSequence = current + LEDGER_WINDOW

  const prepared = await client.autofill(buildTx(intent) as any)
  prepared.Sequence = sequence
  prepared.LastLedgerSequence = lastLedgerSequence

  const signed = wallet.sign(prepared)

  await pool.query(
    `update intents
        set status = 'submitted',
            tx_hash = $2,
            account_sequence = $3,
            last_ledger_seq = $4,
            submitted_at = now(),
            attempts = attempts + 1
      where intent_id = $1`,
    [intentId, signed.hash, sequence, lastLedgerSequence],
  )

  try {
    await client.request({
      command: 'submit',
      tx_blob: signed.tx_blob,
    } as any)
  } catch (e: any) {
    // A rejected submission is not a failed transaction — the ledger
    // never saw it. Put the sequence back by resyncing, and fail the
    // intent rather than leaving it 'submitted' forever.
    await resyncSequence(client, intent.actor)
    await pool.query(
      `update intents
          set status = 'failed',
              engine_result = 'submission_rejected',
              failure_reason = $2,
              resolved_at = now()
        where intent_id = $1`,
      [intentId, String(e?.message ?? e)],
    )
    throw e
  }

  const [updated] = await query<IntentRow>(
    `select * from intents where intent_id = $1`, [intentId],
  )
  return updated
}
