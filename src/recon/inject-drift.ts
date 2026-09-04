/**
 * Deliberately corrupt the projection, so the reconciler has something
 * to find.
 *
 * Two reasons this exists:
 *
 *   1. A reconciler that has only ever reported "no drift" is untested.
 *      The absence of an alarm proves nothing until you've seen it fire.
 *
 *   2. The regulator view needs a demo moment. A panel that permanently
 *      reads "all clear" demonstrates nothing.
 *
 * It writes a wrong balance straight into `holdings`, bypassing the
 * projection — which is the shape of a real bug: the database looks
 * internally consistent and disagrees with the ledger.
 *
 * `npm run project -- --rebuild` undoes it, because the projection is a
 * pure function of the log.
 */
import { pool, query } from '../db/pool.js'

const args = process.argv.slice(2)
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const wantAccount = arg('account')
const amount = Number(arg('amount') ?? 137)

const rows = await query<{
  currency: string; issuer: string; account: string; balance: string
}>(
  wantAccount
    ? `select currency, issuer, account, balance from holdings where account = $1`
    : `select currency, issuer, account, balance from holdings
        where balance > 0 order by random() limit 1`,
  wantAccount ? [wantAccount] : [],
)

if (rows.length === 0) {
  console.log('nothing to corrupt — is the projection populated?')
  await pool.end()
  process.exit(1)
}

const target = rows[0]
const before = Number(target.balance)
const after = before + amount

await pool.query(
  `update holdings set balance = $1
    where currency = $2 and issuer = $3 and account = $4`,
  [after, target.currency, target.issuer, target.account],
)

console.log(`
drift injected.

  account   ${target.account}
  currency  ${target.currency}
  was       ${before}
  now       ${after}   (+${amount})

the ledger still says ${before}. the projection now disagrees.

  npm run reconcile              -- should report CRITICAL drift
  npm run project -- --rebuild   -- replay the log to repair it
`)

await pool.end()
