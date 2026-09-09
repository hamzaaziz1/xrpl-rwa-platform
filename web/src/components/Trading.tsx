/**
 * Trading panel.
 *
 * Shown only to domain members. A non-member sees the eligibility panel
 * instead — the compliance boundary should be the thing you encounter,
 * not a market you can look at but cannot enter.
 *
 * Prices are entered as XRP per unit because that is how a person thinks
 * about a trade. The API takes drops. The conversion happens here, and
 * the total is shown alongside so there is no ambiguity about what is
 * being agreed to.
 */
import { useState } from 'react'
import { api, type Offer, type Book, type Holding } from '../lib/api'
import { shortAddr, units as fmt } from '../lib/format'
import { Panel, Table, Td, Button, Empty } from './ui'

const DROPS_PER_XRP = 1_000_000

const xrp = (drops: string | number) => Number(drops) / DROPS_PER_XRP

/** XRP per unit, which is the number a person actually compares. */
const pricePerUnit = (o: Offer) =>
  Number(o.units) > 0 ? xrp(o.xrp_drops) / Number(o.units) : 0

export function TradingPanel({
  assetId, currency, me, myHolding, book, inFlightAccounts, onDone,
}: {
  assetId: string
  currency: string
  me: { investor_id: string; account: string | null }
  myHolding: Holding | undefined
  book: Book | null
  inFlightAccounts: Set<string>
  onDone: () => void
}) {
  const [side, setSide] = useState<'ask' | 'bid'>('ask')
  const [units, setUnits] = useState('')
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const held = Number(myHolding?.balance ?? 0)
  const frozen = myHolding?.frozen ?? false
  const totalXrp = Number(units) > 0 && Number(price) > 0
    ? Number(units) * Number(price)
    : 0

  const mine = (o: Offer) => o.account === me.account
  const busyHere = busy || (me.account ? inFlightAccounts.has(me.account) : false)

  async function place() {
    setErr(null)
    if (!Number(units) || !Number(price)) {
      setErr('Enter both a quantity and a price.')
      return
    }
    if (side === 'ask' && Number(units) > held) {
      setErr(`You hold ${fmt(held)} ${currency}.`)
      return
    }
    setBusy(true)
    try {
      await api.placeOffer(assetId, {
        investorId: me.investor_id,
        side,
        units: String(units),
        xrpDrops: String(Math.round(totalXrp * DROPS_PER_XRP)),
      })
      setUnits(''); setPrice('')
      onDone()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  async function cancel(sequence: number) {
    setErr(null)
    setBusy(true)
    try {
      await api.cancelOffer(me.investor_id, sequence)
      onDone()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const asks = book?.asks ?? []
  const bids = book?.bids ?? []
  const myOffers = [...asks, ...bids].filter(mine)

  return (
    <>
      <Panel
        title="Place an offer"
        subtitle={`Restricted to members of this asset's permissioned domain`}
      >
        {frozen && (
          <p className="mb-3 border-l-2 border-red-400 bg-red-50 py-2 pl-3 text-xs text-red-900">
            This holding is frozen by the issuer. You cannot sell until it is
            unfrozen. Your balance is unaffected.
          </p>
        )}

        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs text-neutral-500">Side</label>
            <div className="mt-1 flex">
              {(['ask', 'bid'] as const).map(sd => (
                <button
                  key={sd}
                  onClick={() => setSide(sd)}
                  className={[
                    'border px-3 py-1 text-xs',
                    sd === 'ask' ? 'border-r-0' : '',
                    side === sd
                      ? 'border-neutral-800 bg-neutral-800 text-white'
                      : 'border-neutral-300 text-neutral-700 hover:bg-neutral-100',
                  ].join(' ')}
                >
                  {sd === 'ask' ? 'Sell' : 'Buy'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-neutral-500">
              Units {side === 'ask' && <span className="text-neutral-400">(hold {fmt(held)})</span>}
            </label>
            <input
              value={units}
              onChange={e => setUnits(e.target.value)}
              placeholder="50"
              className="mt-1 w-28 border border-neutral-300 px-2 py-1 text-sm tabular-nums"
            />
          </div>

          <div>
            <label className="block text-xs text-neutral-500">Price (XRP per unit)</label>
            <input
              value={price}
              onChange={e => setPrice(e.target.value)}
              placeholder="0.10"
              className="mt-1 w-28 border border-neutral-300 px-2 py-1 text-sm tabular-nums"
            />
          </div>

          <Button disabled={busyHere || (side === 'ask' && frozen)} onClick={place}>
            {busyHere ? 'submitting…' : 'Place offer'}
          </Button>
        </div>

        {totalXrp > 0 && (
          <p className="mt-3 text-sm text-neutral-700">
            {side === 'ask' ? 'Selling' : 'Buying'}{' '}
            <strong className="tabular-nums">{fmt(units)} {currency}</strong>{' '}
            for <strong className="tabular-nums">{totalXrp.toFixed(6)} XRP</strong>
          </p>
        )}

        {err && (
          <p className="mt-3 border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            {err}
          </p>
        )}
      </Panel>

      {myOffers.length > 0 && (
        <Panel title="Your resting offers" subtitle="Live on the ledger until filled or cancelled">
          <Table head={['Side', 'Units', 'Price', 'Total', '']}>
            {myOffers.map(o => (
              <tr key={`${o.account}-${o.sequence}`}>
                <Td>{o.side === 'ask' ? 'Sell' : 'Buy'}</Td>
                <Td right>{fmt(o.units)}</Td>
                <Td right>{pricePerUnit(o).toFixed(6)}</Td>
                <Td right>{xrp(o.xrp_drops).toFixed(6)} XRP</Td>
                <Td right>
                  <Button disabled={busyHere} onClick={() => cancel(o.sequence)}>
                    Cancel
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Panel>
      )}

      <Panel
        title="Order book"
        subtitle="Permissioned — these offers can only match other domain members"
      >
        <div className="grid grid-cols-2 gap-6">
          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
              Asks — units for sale
            </h3>
            {asks.length === 0 ? (
              <Empty>None</Empty>
            ) : (
              <Table head={['Units', 'Price', 'Seller']}>
                {asks.map(o => (
                  <tr key={`${o.account}-${o.sequence}`} className={mine(o) ? 'bg-neutral-50' : ''}>
                    <Td right>{fmt(o.units)}</Td>
                    <Td right>{pricePerUnit(o).toFixed(6)}</Td>
                    <Td>
                      {o.legal_name ?? shortAddr(o.account)}
                      {mine(o) && <span className="ml-2 text-xs text-neutral-400">you</span>}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
              Bids — units wanted
            </h3>
            {bids.length === 0 ? (
              <Empty>None</Empty>
            ) : (
              <Table head={['Units', 'Price', 'Buyer']}>
                {bids.map(o => (
                  <tr key={`${o.account}-${o.sequence}`} className={mine(o) ? 'bg-neutral-50' : ''}>
                    <Td right>{fmt(o.units)}</Td>
                    <Td right>{pricePerUnit(o).toFixed(6)}</Td>
                    <Td>
                      {o.legal_name ?? shortAddr(o.account)}
                      {mine(o) && <span className="ml-2 text-xs text-neutral-400">you</span>}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        </div>

        <p className="mt-4 border-l-2 border-neutral-300 pl-3 text-xs leading-relaxed text-neutral-600">
          Offers carry the asset's domain ID and only ever match offers carrying
          the same one. A non-member is not rejected when they try to trade —
          their offer would go into a different book entirely, so the two can
          never cross.
        </p>
      </Panel>
    </>
  )
}
