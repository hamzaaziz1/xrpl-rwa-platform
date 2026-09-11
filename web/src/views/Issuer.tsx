/**
 * Issuer view.
 *
 * Approve KYC, issue units, freeze, claw back. Every action creates an
 * intent and returns immediately — the row shows what's in flight.
 */
import { useState } from 'react'
import { api } from '../lib/api'
import type { Snapshot } from '../lib/store'
import {
  shortAddr, shortHash, units, ago, explorerTx, INTENT_LABEL,
} from '../lib/format'
import { Panel, Table, Td, Status, Button, Empty } from '../components/ui'

export function IssuerView({ platform }: { platform: Snapshot & { refresh: () => void } }) {
  const { assets, holdings, investors, intents, refresh } = platform
  // Scoped to the SELECTED asset. Using assets[0] here showed the
  // first asset's figures beside the selected asset's holdings — a
  // summary panel confidently describing a different asset from the
  // table beneath it.
  const asset = assets.find(a => a.asset_id === platform.assetId) ?? assets[0]
  const [busy, setBusy] = useState<string | null>(null)
  const [clawTarget, setClawTarget] = useState<string | null>(null)
  const [clawAmount, setClawAmount] = useState('')

  if (!asset) return <Empty>No asset. Run <code>npm run seed</code>.</Empty>

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key)
    try { await fn(); await refresh() }
    catch (e: any) { alert(e?.message ?? String(e)) }
    finally { setBusy(null) }
  }

  const pendingKyc = investors.filter(
    i => i.kyc_status !== 'approved' && i.kyc_status !== 'system',
  )

  // an intent still moving through its lifecycle for this account
  const liveFor = (account: string) =>
    intents.find(
      i => (i.status === 'pending' || i.status === 'submitted') &&
           JSON.stringify(i).includes(account),
    )

  return (
    <div className="space-y-6">

      <Panel
        title="Asset"
        subtitle={`${asset.jurisdiction ?? ''} · ${asset.status}`}
      >
        <dl className="grid grid-cols-4 gap-6 text-sm">
          <div>
            <dt className="text-xs text-neutral-500">Units outstanding</dt>
            <dd className="mt-1 text-lg tabular-nums">{units(asset.units_outstanding)}</dd>
            <dd className="text-xs text-neutral-400">held on ledger</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Issue ceiling</dt>
            <dd className="mt-1 text-lg tabular-nums text-neutral-500">
              {units(asset.total_units)}
            </dd>
            <dd className="text-xs text-neutral-400">registry limit</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Holders</dt>
            <dd className="mt-1 text-lg tabular-nums">
              {holdings.filter(h => Number(h.balance) > 0).length}
            </dd>
            <dd className="text-xs text-neutral-400">with a non-zero balance</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Issuer</dt>
            <dd className="mt-1 font-mono text-xs">{shortAddr(asset.issuer)}</dd>
          </div>
        </dl>
      </Panel>

      {pendingKyc.length > 0 && (
        <Panel title="KYC applications" subtitle="Approval issues an on-ledger credential">
          <Table head={['Investor', 'Account', 'Status', '']}>
            {pendingKyc.map(inv => (
              <tr key={inv.investor_id}>
                <Td>{inv.legal_name}</Td>
                <Td mono>{shortAddr(inv.account)}</Td>
                <Td><Status value={inv.kyc_status} /></Td>
                <Td right>
                  {liveFor(inv.account ?? '') ? (
                    <span className="text-xs text-amber-700">submitting…</span>
                  ) : (
                    <Button
                      disabled={busy === inv.investor_id}
                      onClick={() => act(inv.investor_id, () => api.approve(inv.investor_id))}
                    >
                      Approve
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Panel>
      )}

            <Panel title="Register" subtitle="All accounts with a trust line for this asset">
        {holdings.length === 0 ? (
          <Empty>No holders yet.</Empty>
        ) : (
          <Table head={['Holder', 'Account', 'Balance', 'Actions']}>
            {holdings.map(h => {
              const live = liveFor(h.account)
              return (
                <tr key={h.account} className={h.frozen ? 'bg-red-50' : ''}>
                  <Td>
                    {h.legal_name ?? '—'}
                    {h.frozen && (
                      <span className="ml-2 border border-red-300 bg-red-50 px-1.5 py-0.5 text-xs text-red-800">
                        frozen
                      </span>
                    )}
                  </Td>
                  <Td mono>{shortAddr(h.account)}</Td>
                  <Td right>{units(h.balance)}</Td>
                  <Td right>
                    {live ? (
                      <span className="text-xs text-amber-700">
                        {INTENT_LABEL[live.kind] ?? live.kind} · {live.status}…
                      </span>
                    ) : (
                      <div className="flex justify-end gap-2">
                        {h.frozen ? (
                          <Button
                            disabled={busy === h.account}
                            onClick={() => act(h.account, () => api.unfreeze(asset.asset_id, h.account))}
                          >
                            Unfreeze
                          </Button>
                        ) : (
                          <Button
                            disabled={busy === h.account}
                            onClick={() => act(h.account, () => api.freeze(asset.asset_id, h.account))}
                          >
                            Freeze
                          </Button>
                        )}
                        <Button
                          danger
                          disabled={busy === h.account || Number(h.balance) <= 0}
                          onClick={() => { setClawTarget(h.account); setClawAmount(h.balance) }}
                        >
                          Claw back
                        </Button>
                      </div>
                    )}
                  </Td>
                </tr>
              )
            })}
          </Table>
        )}

        {clawTarget && (
          <div className="mt-4 border border-red-300 bg-red-50 p-4">
            <p className="text-sm text-red-900">
              Claw back from <span className="font-mono">{shortAddr(clawTarget)}</span>
            </p>
            <p className="mt-1 text-xs text-red-800">
              This holder has{' '}
              <strong>
                {units(holdings.find(h => h.account === clawTarget)?.balance ?? 0)}
              </strong>{' '}
              units. Clawback clamps to the available balance — asking for more
              than exists takes everything and still reports success.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <input
                value={clawAmount}
                onChange={e => setClawAmount(e.target.value)}
                className="w-32 border border-red-300 px-2 py-1 text-sm tabular-nums"
              />
              <Button
                danger
                disabled={busy === clawTarget || !clawAmount}
                onClick={() => {
                  const t = clawTarget
                  setClawTarget(null)
                  act(t, () => api.clawback(asset.asset_id, t, clawAmount))
                }}
              >
                Confirm clawback
              </Button>
              <Button onClick={() => setClawTarget(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Recent operations" subtitle="Every write is recorded as an intent before it is submitted">
        {intents.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <Table head={['Operation', 'Status', 'Transaction', 'When', 'Detail']}>
            {intents.slice(0, 12).map(i => (
              <tr key={i.intent_id}>
                <Td>{INTENT_LABEL[i.kind] ?? i.kind}</Td>
                <Td><Status value={i.status} /></Td>
                <Td mono>
                  {i.tx_hash ? (
                      <a
                        href={explorerTx(i.tx_hash)}
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-neutral-300 hover:decoration-neutral-600"
                    >
                      {shortHash(i.tx_hash)}
                    </a>
                  ) : '—'}
                </Td>
                <Td>{ago(i.created_at)}</Td>
                <Td>
                  {i.failure_reason ? (
                    <span className="text-xs text-red-800">{i.failure_reason}</span>
                  ) : (
                    <span className="text-xs text-neutral-400">
                      {i.engine_result ?? ''}
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  )
}