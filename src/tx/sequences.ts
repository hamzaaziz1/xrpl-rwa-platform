/**
 * Sequence allocation.
 *
 * Every XRPL transaction carries a sequence number for its sending
 * account. They must be used exactly once, in order.
 *
 * The naive approach — read the account's current sequence from the
 * ledger at submit time — breaks under concurrency. Two requests read
 * the same number, both build a transaction with it, one lands and the
 * other fails with tefPAST_SEQ. It works perfectly in testing and
 * fails the moment two things happen at once.
 *
 * So sequences are allocated from a database row under `FOR UPDATE`,
 * which serialises concurrent allocators. The ledger is consulted only
 * to initialise the counter, and to resync when we've drifted.
 */
import type { Client } from 'xrpl'
import { pool } from '../db/pool.js'

/**
 * Allocate the next sequence for `account`, atomically.
 * Initialises from the ledger on first use.
 */
export async function allocateSequence(
  client: Client, account: string,
): Promise<number> {
  const db = await pool.connect()
  try {
    await db.query('begin')

    const { rows } = await db.query<{ next_sequence: number }>(
      `select next_sequence from account_sequences
        where account = $1 for update`,
      [account],
    )

    let next: number

    if (rows.length === 0) {
      // first use — ask the ledger where we are
      const info: any = await client.request({
        command: 'account_info',
        account,
        ledger_index: 'validated',
      })
      next = info.result.account_data.Sequence

      await db.query(
        `insert into account_sequences (account, next_sequence)
         values ($1, $2)
         on conflict (account) do nothing`,
        [account, next],
      )
    } else {
      next = rows[0].next_sequence
    }

    await db.query(
      `update account_sequences
          set next_sequence = $2, updated_at = now()
        where account = $1`,
      [account, next + 1],
    )

    await db.query('commit')
    return next
  } catch (e) {
    await db.query('rollback')
    throw e
  } finally {
    db.release()
  }
}

/**
 * Force the counter back into agreement with the ledger.
 *
 * Needed after gaps — an expired transaction burns a sequence number
 * from our counter's perspective but not from the ledger's, so we can
 * end up ahead. Every subsequent submission then fails with tefPAST_SEQ
 * until this is called.
 */
export async function resyncSequence(
  client: Client, account: string,
): Promise<number> {
  const info: any = await client.request({
    command: 'account_info',
    account,
    ledger_index: 'validated',
  })
  const ledgerSeq = info.result.account_data.Sequence

  await pool.query(
    `insert into account_sequences (account, next_sequence)
     values ($1, $2)
     on conflict (account) do update
       set next_sequence = $2, updated_at = now()`,
    [account, ledgerSeq],
  )

  return ledgerSeq
}
