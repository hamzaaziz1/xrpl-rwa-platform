/**
 * Seeds a demo asset and two investors, producing real ledger activity
 * for the ingest and projection to consume.
 *
 * Idempotent in the sense that it always starts fresh: every run funds
 * NEW accounts. It does not attempt to reuse previous state, because a
 * script that assumes a starting state and doesn't check will one day
 * print confident labels over completely wrong data.
 *
 * Run `npm run reset` first if you want a clean database too.
 */
import { Wallet } from 'xrpl'
import { connect } from './xrpl-client.js'
import { pool } from './db/pool.js'

const CURRENCY = 'PRP'
const ASSET_ID = 'prop-001'

const toHex = (s: string) =>
  Buffer.from(s, 'utf8').toString('hex').toUpperCase()

const CRED_TYPE = toHex('KYC')

// AccountSet flags (the numbers you SET, not the bits you read back)
const asfRequireAuth            = 2
const asfDefaultRipple          = 8
const asfAllowTrustLineClawback = 16

// TrustSet flags
const tfSetfAuth = 0x00010000

const client = await connect()

async function send(label: string, tx: any, wallet: Wallet) {
  process.stdout.write(`  ${label.padEnd(38)} `)
  const res: any = await client.submitAndWait(tx, { wallet })
  const code = res.result.meta.TransactionResult
  console.log(code)
  if (code !== 'tesSUCCESS') throw new Error(`${label}: ${code}`)
  return res
}

console.log('\n=== issuer ===')
const { wallet: issuer } = await client.fundWallet()
console.log(`  ${issuer.address}`)

// clawback FIRST — it cannot be enabled once any trust line exists
await send('AccountSet: AllowTrustLineClawback', {
  TransactionType: 'AccountSet', Account: issuer.address,
  SetFlag: asfAllowTrustLineClawback,
}, issuer)

await send('AccountSet: RequireAuth', {
  TransactionType: 'AccountSet', Account: issuer.address,
  SetFlag: asfRequireAuth,
}, issuer)

await send('AccountSet: DefaultRipple', {
  TransactionType: 'AccountSet', Account: issuer.address,
  SetFlag: asfDefaultRipple,
}, issuer)

console.log('\n=== kyc issuer / domain owner ===')
const { wallet: kyc } = await client.fundWallet()
console.log(`  ${kyc.address}`)

const domRes = await send('PermissionedDomainSet', {
  TransactionType: 'PermissionedDomainSet',
  Account: kyc.address,
  AcceptedCredentials: [
    { Credential: { Issuer: kyc.address, CredentialType: CRED_TYPE } },
  ],
}, kyc)

const domainId = (domRes.result.meta.AffectedNodes as any[])
  .map((n: any) => n.CreatedNode)
  .find((n: any) => n?.LedgerEntryType === 'PermissionedDomain')
  ?.LedgerIndex

if (!domainId) throw new Error('domain not created')
console.log(`  domain ${domainId.slice(0, 16)}...`)

async function onboard(name: string, prp: string) {
  console.log(`\n=== ${name} ===`)
  const { wallet } = await client.fundWallet()
  console.log(`  ${wallet.address}`)

  await send('TrustSet (open line)', {
    TransactionType: 'TrustSet',
    Account: wallet.address,
    LimitAmount: { currency: CURRENCY, issuer: issuer.address, value: '1000000' },
  }, wallet)

  await send('TrustSet (issuer authorizes)', {
    TransactionType: 'TrustSet',
    Account: issuer.address,
    LimitAmount: { currency: CURRENCY, issuer: wallet.address, value: '0' },
    Flags: tfSetfAuth,
  }, issuer)

  await send('CredentialCreate', {
    TransactionType: 'CredentialCreate',
    Account: kyc.address,
    Subject: wallet.address,
    CredentialType: CRED_TYPE,
  }, kyc)

  await send('CredentialAccept', {
    TransactionType: 'CredentialAccept',
    Account: wallet.address,
    Issuer: kyc.address,
    CredentialType: CRED_TYPE,
  }, wallet)

  if (prp !== '0') {
    await send(`Payment: issue ${prp} PRP`, {
      TransactionType: 'Payment',
      Account: issuer.address,
      Destination: wallet.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: prp },
    }, issuer)
  }

  return wallet
}

const alice = await onboard('alice', '500')
const bob   = await onboard('bob',   '0')

console.log('\n=== permissioned trade ===')
await send('alice: sell 100 PRP for 10 XRP', {
  TransactionType: 'OfferCreate',
  Account: alice.address,
  TakerGets: { currency: CURRENCY, issuer: issuer.address, value: '100' },
  TakerPays: '10000000',
  DomainID: domainId,
}, alice)

await send('bob: take the other side', {
  TransactionType: 'OfferCreate',
  Account: bob.address,
  TakerGets: '10000000',
  TakerPays: { currency: CURRENCY, issuer: issuer.address, value: '100' },
  DomainID: domainId,
}, bob)

// ---- registry ----------------------------------------------------

console.log('\n=== registry ===')

await pool.query(
  `insert into assets
     (asset_id, currency, issuer, title, external_ref, jurisdiction, total_units, domain_id)
   values ($1, $2, $3, $4, $5, $6, $7, $8)
   on conflict (asset_id) do update
     set currency  = excluded.currency,
         issuer    = excluded.issuer,
         domain_id = excluded.domain_id`,
  [ASSET_ID, CURRENCY, issuer.address,
   '12 Marina Walk, Unit 4B', 'DLD-2026-004471', 'AE-DU', 500, domainId],
)
console.log(`  asset ${ASSET_ID}`)

// carol applies but is NOT approved, so the KYC flow is demonstrable
const { wallet: carol } = await client.fundWallet()
console.log(`  carol (pending KYC) ${carol.address}`)

await pool.query(
  `insert into investors
     (investor_id, legal_name, account, seed, kyc_status, kyc_submitted)
   values ('inv-003', 'Carol Mensah', $1, $2, 'pending', now())
   on conflict (investor_id) do update
     set account = excluded.account, seed = excluded.seed,
         kyc_status = 'pending', kyc_approved = null,
         credential_accepted_at = null`,
  [carol.address, carol.seed],
)

for (const [id, name, w] of [
  ['inv-001', 'Alice Nakamura', alice],
  ['inv-002', 'Bob Osei', bob],
] as const) {
  await pool.query(
    `insert into investors
       (investor_id, legal_name, account, seed, kyc_status,
        kyc_submitted, kyc_approved, credential_accepted_at)
     values ($1, $2, $3, $4, 'approved', now(), now(), now())
     on conflict (investor_id) do update
       set account = excluded.account, seed = excluded.seed`,
    [id, name, w.address, w.seed],
  )
  console.log(`  investor ${id}  ${name}`)
}

// domain owner is stored so the API can issue credentials later
await pool.query(
  `insert into investors (investor_id, legal_name, account, seed, kyc_status)
   values ('sys-kyc', 'KYC Issuer (system)', $1, $2, 'system')
   on conflict (investor_id) do update
     set account = excluded.account, seed = excluded.seed`,
  [kyc.address, kyc.seed],
)

// issuer seed too — testnet only, see MANUAL section 6
await pool.query(
  `insert into investors (investor_id, legal_name, account, seed, kyc_status)
   values ('sys-issuer', 'Asset Issuer (system)', $1, $2, 'system')
   on conflict (investor_id) do update
     set account = excluded.account, seed = excluded.seed`,
  [issuer.address, issuer.seed],
)

console.log(`
seeded.

  issuer   ${issuer.address}
  kyc      ${kyc.address}
  domain   ${domainId}
  alice    ${alice.address}   (400 PRP after trade)
  bob      ${bob.address}   (100 PRP after trade)

next:
  npm run ingest -- --once
  npm run project
`)

await client.disconnect()
await pool.end()
