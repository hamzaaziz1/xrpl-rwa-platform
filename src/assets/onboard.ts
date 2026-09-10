/**
 * Onboarding an investor to an asset.
 *
 * A new asset with no way to give anyone units is a demo of an empty
 * table. This is the piece that makes asset creation useful.
 *
 * Three steps, two signers:
 *
 *   1. the INVESTOR opens a trust line          (investor signs)
 *   2. the ISSUER authorises it                 (issuer signs)
 *   3. the ISSUER sends units                   (issuer signs)
 *
 * Step 2 cannot run until step 1 has been validated — there is no line
 * to authorise otherwise. Step 3 cannot run until step 2 lands, or it
 * returns tecPATH_DRY (which, per the write-up, is the ledger's way of
 * saying "not authorised" while appearing to say "no liquidity").
 *
 * So these are three intents with a real ordering dependency, and the
 * worker submits intents in creation order per account. But steps 1 and
 * 2 are signed by DIFFERENT accounts, so per-account ordering is not
 * enough on its own.
 *
 * Rather than build a dependency graph for a three-step bootstrap, this
 * runs inline like asset creation. Same reasoning: it is a one-time
 * setup, a partial result is not a state worth representing, and 15
 * seconds with a spinner beats a half-onboarded investor.
 */
import { Wallet, type Client } from 'xrpl'
import { pool, query } from '../db/pool.js'

const tfSetfAuth = 0x00010000

export interface OnboardInput {
  assetId: string
  investorId: string
  units?: string          // optional initial allocation
  limit?: string
}

async function send(
  client: Client, wallet: Wallet, label: string, tx: any,
) {
  const res: any = await client.submitAndWait(tx, { wallet })
  const result = res.result.meta.TransactionResult
  if (result !== 'tesSUCCESS') throw new Error(`${label} failed: ${result}`)
  return { label, hash: res.result.hash, result }
}

export async function onboardInvestor(
  client: Client, input: OnboardInput,
) {
  const { assetId, investorId } = input
  const limit = input.limit ?? '1000000'

  const [asset] = await query<{
    currency: string; issuer: string; issuer_seed: string | null
    total_units: string | null
  }>(
    `select currency, issuer, issuer_seed, total_units
       from assets where asset_id = $1`,
    [assetId],
  )
  if (!asset) throw new Error(`unknown asset ${assetId}`)

  // Assets created by the seed script store the issuer seed in
  // `investors` under sys-issuer; assets created through the API store
  // it on the row. Fall back so both work.
  let issuerSeed = asset.issuer_seed
  if (!issuerSeed) {
    const [row] = await query<{ seed: string }>(
      `select seed from investors where account = $1 and seed is not null`,
      [asset.issuer],
    )
    issuerSeed = row?.seed ?? null
  }
  if (!issuerSeed) throw new Error('no key material for this asset\'s issuer')

  const [investor] = await query<{ account: string | null; seed: string | null }>(
    `select account, seed from investors where investor_id = $1`,
    [investorId],
  )
  if (!investor?.account || !investor.seed) {
    throw new Error(`investor ${investorId} has no account`)
  }

  // Eligibility: an accepted, unrevoked credential. Same gate as
  // trading, checked here so an ineligible investor cannot be given a
  // position they could not trade.
  const [cred] = await query<{ accepted_at: string | null; revoked_at: string | null }>(
    `select accepted_at, revoked_at from credentials where subject = $1`,
    [investor.account],
  )
  if (!cred?.accepted_at || cred.revoked_at) {
    throw new Error(
      'investor holds no accepted credential — approve and accept KYC before allocating units',
    )
  }

  if (input.units && Number(input.units) > 0) {
    const outstanding = await query<{ balance: string }>(
      `select balance from holdings
        where currency = $1 and issuer = $2 and account = $2`,
      [asset.currency, asset.issuer],
    )
    const issued = Math.abs(Number(outstanding[0]?.balance ?? 0))
    const ceiling = Number(asset.total_units ?? Infinity)
    if (issued + Number(input.units) > ceiling) {
      throw new Error(
        `issue ceiling exceeded: ${issued} outstanding, ceiling ${ceiling}, requested ${input.units}`,
      )
    }
  }

  const issuerWallet = Wallet.fromSeed(issuerSeed)
  const investorWallet = Wallet.fromSeed(investor.seed)
  const transactions = []

  // ---- 1. investor opts in ---------------------------------------
  transactions.push(await send(client, investorWallet, 'TrustSet (open line)', {
    TransactionType: 'TrustSet',
    Account: investor.account,
    LimitAmount: { currency: asset.currency, issuer: asset.issuer, value: limit },
  }))

  // ---- 2. issuer authorises --------------------------------------
  // NOTE the direction: `issuer` here names the HOLDER. The issuer is
  // editing its own side of a two-sided relationship, so it names the
  // counterparty. Sixth or seventh instance of this in the project.
  transactions.push(await send(client, issuerWallet, 'TrustSet (authorise)', {
    TransactionType: 'TrustSet',
    Account: asset.issuer,
    LimitAmount: { currency: asset.currency, issuer: investor.account, value: '0' },
    Flags: tfSetfAuth,
  }))

  // ---- 3. optional initial allocation ---------------------------
  if (input.units && Number(input.units) > 0) {
    transactions.push(await send(client, issuerWallet, `Payment (${input.units})`, {
      TransactionType: 'Payment',
      Account: asset.issuer,
      Destination: investor.account,
      Amount: {
        currency: asset.currency,
        issuer: asset.issuer,
        value: String(input.units),
      },
    }))
  }

  await pool.query(
    `update investors set kyc_submitted = coalesce(kyc_submitted, now())
      where investor_id = $1`,
    [investorId],
  )

  return { assetId, investorId, account: investor.account, transactions }
}
