/**
 * Offer projection.
 *
 * An OfferCreate that doesn't fully cross leaves an Offer object on the
 * ledger. That is state, so it is derived from the event log like
 * balances and credentials.
 *
 * THE SUBTLETY, and it is the whole reason this file is more than ten
 * lines:
 *
 * An offer can be consumed by SOMEONE ELSE'S transaction. When Bob's
 * OfferCreate crosses Alice's resting offer, Alice's offer is deleted —
 * but Alice submitted nothing. A projection built only from each
 * account's own transactions would keep showing offers that no longer
 * exist.
 *
 * The deletion IS recorded, in the crossing transaction's metadata, as
 * a DeletedNode of type Offer. So the projection reads metadata for
 * offer deletions regardless of who submitted the transaction, and
 * because ingest watches every investor account, the crossing
 * transaction is always in the log.
 *
 * Same lesson as the reconciler: your own actions are not the only
 * thing that changes your state.
 */

export interface OfferRow {
  account: string
  sequence: number
  side: 'ask' | 'bid'
  currency: string
  issuer: string
  units: string
  xrpDrops: string
  domainId: string | null
}

const isXrp = (a: any) => typeof a === 'string'

/**
 * Read an OfferCreate into a row, normalised so `units` is always the
 * issued asset and `xrp_drops` always the XRP side.
 *
 * TakerGets is what the offer gives up, TakerPays what it wants. So an
 * offer giving up the asset is an ASK; one wanting the asset is a BID.
 * Only asset/XRP pairs are tracked — anything else is ignored rather
 * than guessed at.
 */
export function offerFrom(tx: any): OfferRow | null {
  if (tx?.TransactionType !== 'OfferCreate') return null
  const gets = tx.TakerGets
  const pays = tx.TakerPays
  if (!gets || !pays) return null

  if (!isXrp(gets) && isXrp(pays)) {
    // giving up the asset, wanting XRP -> ask
    return {
      account: tx.Account,
      sequence: tx.Sequence,
      side: 'ask',
      currency: gets.currency,
      issuer: gets.issuer,
      units: String(gets.value),
      xrpDrops: String(pays),
      domainId: tx.DomainID ?? null,
    }
  }

  if (isXrp(gets) && !isXrp(pays)) {
    // giving up XRP, wanting the asset -> bid
    return {
      account: tx.Account,
      sequence: tx.Sequence,
      side: 'bid',
      currency: pays.currency,
      issuer: pays.issuer,
      units: String(pays.value),
      xrpDrops: String(gets),
      domainId: tx.DomainID ?? null,
    }
  }

  return null
}

/**
 * Did this OfferCreate actually leave an offer resting on the ledger?
 *
 * An OfferCreate that crosses completely on submission never becomes a
 * ledger object — it executes and is gone. There is no CreatedNode and
 * there will never be a DeletedNode, because nothing was ever created.
 *
 * Recording it anyway leaves a row that can never be closed: the
 * projection shows an open offer the ledger has no knowledge of. That
 * is precisely the drift the reconciler exists to catch, manufactured
 * by the projection itself.
 */
export function offerRested(meta: any, account: string, sequence: number): boolean {
  for (const node of meta?.AffectedNodes ?? []) {
    const created = node.CreatedNode
    if (created?.LedgerEntryType !== 'Offer') continue
    const f = created.NewFields
    if (f?.Account === account && Number(f.Sequence) === sequence) return true
  }
  return false
}

/**
 * Every Offer object deleted by this transaction, whoever submitted it.
 * Returns (account, sequence) pairs identifying the offers.
 */
export function offersDeletedBy(meta: any): Array<{ account: string; sequence: number }> {
  const out: Array<{ account: string; sequence: number }> = []
  for (const node of meta?.AffectedNodes ?? []) {
    const del = node.DeletedNode
    if (del?.LedgerEntryType !== 'Offer') continue
    const f = del.FinalFields ?? del.PreviousFields
    if (!f?.Account || f.Sequence == null) continue
    out.push({ account: f.Account, sequence: Number(f.Sequence) })
  }
  return out
}

/** An explicit OfferCancel names the sequence it is cancelling. */
export function offerCancelledBy(tx: any): { account: string; sequence: number } | null {
  if (tx?.TransactionType !== 'OfferCancel') return null
  if (!tx.Account || tx.OfferSequence == null) return null
  return { account: tx.Account, sequence: Number(tx.OfferSequence) }
}

export async function applyOffer(client: any, o: OfferRow, ledgerIndex: number) {
  await client.query(
    `insert into offers
       (account, sequence, side, currency, issuer, units, xrp_drops,
        domain_id, created_ledger)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (account, sequence) do nothing`,
    [o.account, o.sequence, o.side, o.currency, o.issuer,
     o.units, o.xrpDrops, o.domainId, ledgerIndex],
  )
}

export async function closeOffer(
  client: any, account: string, sequence: number,
  ledgerIndex: number, reason: string,
) {
  await client.query(
    `update offers
        set closed_ledger = $3, closed_reason = $4
      where account = $1 and sequence = $2 and closed_ledger is null`,
    [account, sequence, ledgerIndex, reason],
  )
}
