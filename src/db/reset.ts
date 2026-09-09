/**
 * Drops and recreates every table. Destroys all data.
 *
 * Safe to run because `holdings` is a projection and `ledger_events`
 * can be re-ingested from the ledger. The registry tables (assets,
 * investors) are NOT recoverable this way — back them up first if
 * they contain anything you care about.
 */
import { readFileSync } from 'node:fs'
import { pool } from './pool.js'

await pool.query(`
  drop table if exists
    reconciliation_findings,
    holdings,
    credentials,
    offers,
    ledger_events,
    intents,
    account_sequences,
    sync_state,
    investors,
    assets
  cascade
`)
console.log('tables dropped')

const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
await pool.query(sql)
console.log('schema reapplied')

await pool.end()
