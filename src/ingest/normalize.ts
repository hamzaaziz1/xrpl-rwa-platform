/**
 * XRPL returns transactions in two different shapes depending on the
 * API version and the endpoint:
 *
 *   API v1  ->  { transaction: {...}, meta: {...} }
 *   API v2  ->  { tx_json: {...}, meta: {...}, hash: "...", ledger_index: n }
 *
 * and `account_tx` wraps each entry differently again. Rather than
 * guess which one we'll get, normalize everything at the boundary.
 *
 * This is defensive on purpose: a shape change upstream should produce
 * a loud failure here, not silently-missing events downstream.
 */

export interface NormalizedTx {
  hash: string
  ledgerIndex: number
  txIndex: number
  txType: string
  txResult: string
  account: string
  raw: { tx: any; meta: any }
}

function pickTx(entry: any): any {
  return entry?.tx_json ?? entry?.transaction ?? entry?.tx ?? null
}

function pickMeta(entry: any): any {
  return entry?.meta ?? entry?.metaData ?? null
}

/**
 * Returns null for anything we can't confidently interpret —
 * unvalidated entries, missing metadata, or a shape we don't know.
 * Callers should count nulls rather than ignore them.
 */
export function normalize(entry: any): NormalizedTx | null {
  const tx = pickTx(entry)
  const meta = pickMeta(entry)
  if (!tx || !meta) return null

  const hash = entry.hash ?? tx.hash ?? entry.tx_hash
  if (!hash) return null

  const ledgerIndex =
    entry.ledger_index ?? tx.ledger_index ?? entry.ledgerIndex ?? null
  if (ledgerIndex == null) return null

  const txIndex = meta.TransactionIndex
  if (txIndex == null) return null

  const txResult = meta.TransactionResult
  if (!txResult) return null

  return {
    hash,
    ledgerIndex: Number(ledgerIndex),
    txIndex: Number(txIndex),
    txType: tx.TransactionType ?? 'unknown',
    txResult,
    account: tx.Account ?? '',
    raw: { tx, meta },
  }
}
