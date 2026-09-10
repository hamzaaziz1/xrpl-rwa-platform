/**
 * Asset creation.
 *
 * Each asset gets its OWN issuer account. This is not fastidiousness —
 * issuer controls on XRPL are ACCOUNT-scoped, not currency-scoped:
 *
 *   - a global freeze freezes everything that account issues
 *   - RequireAuth applies to every currency it issues
 *   - AllowTrustLineClawback likewise
 *
 * Share one issuer across assets and a court order against one property
 * freezes the others. Any real tokenization platform issues each asset
 * from its own account, and this one does too.
 *
 * WHY THIS IS SYNCHRONOUS, against the rule everywhere else:
 *
 * Setting up an issuer is four transactions that must land in order —
 * clawback CANNOT be enabled once trust lines exist, so it goes first.
 * The intents machinery exists for operations that can fail and be
 * retried independently. A half-configured issuer is not a state worth
 * representing: an account with RequireAuth but no clawback is
 * permanently unable to gain it.
 *
 * So this runs inline and either completes or leaves nothing behind.
 * The call takes ~20 seconds. That is the honest cost of bootstrapping
 * an account, and a spinner is a better answer than a partially
 * initialised issuer.
 */
import { Wallet, type Client } from 'xrpl'
import { pool, query } from '../db/pool.js'

const asfRequireAuth            = 2
const asfDefaultRipple          = 8
const asfAllowTrustLineClawback = 16

const toHex = (s: string) =>
  Buffer.from(s, 'utf8').toString('hex').toUpperCase()

export interface CreateAssetInput {
  assetId: string
  currency: string        // 3 chars, standard currency code
  title: string
  externalRef?: string
  jurisdiction?: string
  totalUnits: number
}

export interface CreateAssetResult {
  assetId: string
  issuer: string
  domainId: string
  currency: string
  transactions: Array<{ label: string; hash: string; result: string }>
}

async function send(
  client: Client, wallet: Wallet, label: string, tx: any,
): Promise<{ label: string; hash: string; result: string }> {
  const res: any = await client.submitAndWait(tx, { wallet })
  const result = res.result.meta.TransactionResult
  if (result !== 'tesSUCCESS') {
    throw new Error(`${label} failed: ${result}`)
  }
  return { label, hash: res.result.hash, result }
}

export async function createAsset(
  client: Client, input: CreateAssetInput,
): Promise<CreateAssetResult> {
  const { assetId, currency, title, totalUnits } = input

  if (!/^[A-Z0-9]{3}$/.test(currency)) {
    throw new Error('currency must be exactly 3 uppercase alphanumeric characters')
  }
  if (!assetId || !title || !(totalUnits > 0)) {
    throw new Error('assetId, title and a positive totalUnits are required')
  }

  const [existing] = await query(`select 1 from assets where asset_id = $1`, [assetId])
  if (existing) throw new Error(`asset ${assetId} already exists`)

  const [clash] = await query(
    `select asset_id from assets where currency = $1`, [currency],
  )
  if (clash) {
    // Not fatal on-ledger — different issuers make it a different token —
    // but two assets sharing a currency code is confusing enough in a UI
    // that it is worth refusing.
    throw new Error(`currency ${currency} is already used by another asset`)
  }

  const transactions: CreateAssetResult['transactions'] = []

  // ---- 1. fund a dedicated issuer -------------------------------
  const { wallet: issuer } = await client.fundWallet()

  // ---- 2. clawback FIRST ----------------------------------------
  // Cannot be enabled once any trust line exists. Everything else is
  // reversible; this is not.
  transactions.push(await send(client, issuer, 'AllowTrustLineClawback', {
    TransactionType: 'AccountSet',
    Account: issuer.address,
    SetFlag: asfAllowTrustLineClawback,
  }))

  transactions.push(await send(client, issuer, 'RequireAuth', {
    TransactionType: 'AccountSet',
    Account: issuer.address,
    SetFlag: asfRequireAuth,
  }))

  // Without DefaultRipple, units can only move between the issuer and a
  // holder. No secondary market at all.
  transactions.push(await send(client, issuer, 'DefaultRipple', {
    TransactionType: 'AccountSet',
    Account: issuer.address,
    SetFlag: asfDefaultRipple,
  }))

  // ---- 3. a permissioned domain for this asset -------------------
  // Its own domain, for the same reason it gets its own issuer: domain
  // membership should be per-asset, so eligibility for one property
  // does not imply eligibility for another.
  const [kyc] = await query<{ account: string; seed: string }>(
    `select account, seed from investors where investor_id = 'sys-kyc'`,
  )
  if (!kyc?.seed) throw new Error('no system KYC account — seed the platform first')
  const kycWallet = Wallet.fromSeed(kyc.seed)

  const domRes: any = await client.submitAndWait({
    TransactionType: 'PermissionedDomainSet',
    Account: kyc.account,
    AcceptedCredentials: [
      { Credential: { Issuer: kyc.account, CredentialType: toHex('KYC') } },
    ],
  }, { wallet: kycWallet })

  if (domRes.result.meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`PermissionedDomainSet failed: ${domRes.result.meta.TransactionResult}`)
  }

  const domainId = (domRes.result.meta.AffectedNodes as any[])
    .map((n: any) => n.CreatedNode)
    .find((n: any) => n?.LedgerEntryType === 'PermissionedDomain')
    ?.LedgerIndex

  if (!domainId) throw new Error('domain was not created')

  transactions.push({
    label: 'PermissionedDomainSet',
    hash: domRes.result.hash,
    result: 'tesSUCCESS',
  })

  // ---- 4. registry ----------------------------------------------
  await pool.query(
    `insert into assets
       (asset_id, currency, issuer, issuer_seed, title, external_ref,
        jurisdiction, total_units, domain_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [assetId, currency, issuer.address, issuer.seed, title,
     input.externalRef ?? null, input.jurisdiction ?? null,
     totalUnits, domainId],
  )

  // The issuer's seed also goes in `investors` so the existing signing
  // path (walletFor) can find it. That table is doing double duty as a
  // key store, which is noted in the manual as something production
  // would separate.
  await pool.query(
    `insert into investors (investor_id, legal_name, account, seed, kyc_status)
     values ($1, $2, $3, $4, 'system')
     on conflict (investor_id) do update
       set account = excluded.account, seed = excluded.seed`,
    [`sys-issuer-${assetId}`, `Issuer (${assetId})`, issuer.address, issuer.seed],
  )

  return {
    assetId,
    issuer: issuer.address,
    domainId,
    currency,
    transactions,
  }
}
