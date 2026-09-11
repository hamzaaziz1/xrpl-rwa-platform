/**
 * Asset creation and investor onboarding forms.
 *
 * Both call SYNCHRONOUS endpoints, unlike everything else in this UI.
 * Creating an asset is four ordered ledger transactions and onboarding
 * is three across two signers, so these take 15-20 seconds and there is
 * no intent to poll — the request either completes or leaves nothing
 * behind. See assets/create.ts for why that is the right trade.
 *
 * Which means the UI has to be honest about the wait: a disabled button
 * saying "creating…" with the steps listed, rather than a spinner that
 * looks broken after five seconds.
 */
import { useState } from 'react'
import { api } from '../lib/api'
import type { Investor } from '../lib/api'
import { shortAddr } from '../lib/format'
import { Panel, Button } from './ui'

const field = 'mt-1 w-full border border-neutral-300 px-2 py-1 text-sm'
const label = 'block text-xs text-neutral-500'

export function CreateAssetForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [assetId, setAssetId] = useState('')
  const [currency, setCurrency] = useState('')
  const [title, setTitle] = useState('')
  const [externalRef, setExternalRef] = useState('')
  const [jurisdiction, setJurisdiction] = useState('')
  const [totalUnits, setTotalUnits] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<any>(null)

  async function submit() {
    setErr(null)
    setBusy(true)
    try {
      const res = await api.createAsset({
        assetId: assetId.trim(),
        currency: currency.trim().toUpperCase(),
        title: title.trim(),
        externalRef: externalRef.trim() || undefined,
        jurisdiction: jurisdiction.trim() || undefined,
        totalUnits: Number(totalUnits),
      })
      setDone(res)
      setAssetId(''); setCurrency(''); setTitle('')
      setExternalRef(''); setJurisdiction(''); setTotalUnits('')
      onCreated()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Panel
        title="Assets"
        subtitle="Each asset is issued from its own account and gated by its own domain"
        right={<Button onClick={() => setOpen(true)}>New asset</Button>}
      >
        <p className="text-xs leading-relaxed text-neutral-600">
          Issuer controls on the XRP Ledger are account-scoped rather than
          currency-scoped — a global freeze or an authorisation requirement
          applies to everything an account issues. Sharing one issuer across
          assets would mean an intervention against one property affecting the
          others, so each asset gets a dedicated issuer account and a dedicated
          permissioned domain.
        </p>
      </Panel>
    )
  }

  return (
    <Panel
      title="New asset"
      subtitle="Funds an issuer, configures its controls, and creates a permissioned domain"
      right={<Button onClick={() => { setOpen(false); setDone(null) }}>Close</Button>}
    >
      {done && (
        <div className="mb-4 border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-900">
          <p className="font-medium">Created {done.assetId}</p>
          <p className="mt-1 font-mono">issuer {shortAddr(done.issuer, 10)}</p>
          <p className="font-mono">domain {done.domainId?.slice(0, 16)}…</p>
          <ul className="mt-2 space-y-0.5">
            {done.transactions?.map((t: any) => (
              <li key={t.hash} className="font-mono">
                {t.result} · {t.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={label}>Asset ID</label>
          <input value={assetId} onChange={e => setAssetId(e.target.value)}
                 placeholder="prop-003" className={field} />
        </div>
        <div>
          <label className={label}>Currency code (3 chars)</label>
          <input value={currency} onChange={e => setCurrency(e.target.value.toUpperCase())}
                 placeholder="VLA" maxLength={3} className={`${field} font-mono`} />
        </div>
        <div>
          <label className={label}>Issue ceiling (units)</label>
          <input value={totalUnits} onChange={e => setTotalUnits(e.target.value)}
                 placeholder="1000" className={`${field} tabular-nums`} />
        </div>
        <div className="col-span-2">
          <label className={label}>Title</label>
          <input value={title} onChange={e => setTitle(e.target.value)}
                 placeholder="Villa 7, Palm Jumeirah" className={field} />
        </div>
        <div>
          <label className={label}>Jurisdiction</label>
          <input value={jurisdiction} onChange={e => setJurisdiction(e.target.value)}
                 placeholder="AE-DU" className={field} />
        </div>
        <div className="col-span-2">
          <label className={label}>External reference</label>
          <input value={externalRef} onChange={e => setExternalRef(e.target.value)}
                 placeholder="DLD-2026-011204" className={field} />
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button
          disabled={busy || !assetId || !currency || !title || !totalUnits}
          onClick={submit}
        >
          {busy ? 'creating…' : 'Create asset'}
        </Button>
        {busy && (
          <span className="text-xs text-amber-700">
            four ledger transactions — clawback, authorisation, rippling, domain.
            This takes about 20 seconds.
          </span>
        )}
      </div>

      {err && (
        <p className="mt-3 border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {err}
        </p>
      )}

      <p className="mt-4 border-l-2 border-neutral-300 pl-3 text-xs leading-relaxed text-neutral-600">
        Clawback is enabled first and deliberately: it cannot be set once any
        trust line exists, so an issuer configured in the wrong order can never
        gain it. That is why this runs as one synchronous operation rather than
        through the intent queue — a partial result here is a permanently broken
        account, not a retryable failure.
      </p>
    </Panel>
  )
}

export function OnboardForm({
  assetId, currency, investors, holders, onDone,
}: {
  assetId: string
  currency: string
  investors: Investor[]
  holders: Set<string>
  onDone: () => void
}) {
  const [investorId, setInvestorId] = useState('')
  const [units, setUnits] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // Only approved investors who don't already hold this asset. An
  // unapproved investor cannot be allocated units they could not trade.
  const eligible = investors.filter(
    i => i.kyc_status === 'approved' && i.account && !holders.has(i.account),
  )

  if (eligible.length === 0) return null

  async function submit() {
    setErr(null); setMsg(null); setBusy(true)
    try {
      const res = await api.onboard(assetId, {
        investorId,
        units: units.trim() || undefined,
      })
      setMsg(`${res.transactions.length} transaction(s) confirmed`)
      setInvestorId(''); setUnits('')
      onDone()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title="Onboard an investor"
      subtitle={`Opens a trust line for ${currency}, authorises it, and optionally allocates units`}
    >
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className={label}>Investor</label>
          <select
            value={investorId}
            onChange={e => setInvestorId(e.target.value)}
            className="mt-1 border border-neutral-300 bg-white px-2 py-1 text-sm"
          >
            <option value="">select…</option>
            {eligible.map(i => (
              <option key={i.investor_id} value={i.investor_id}>
                {i.legal_name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>Initial allocation (optional)</label>
          <input value={units} onChange={e => setUnits(e.target.value)}
                 placeholder="100"
                 className="mt-1 w-28 border border-neutral-300 px-2 py-1 text-sm tabular-nums" />
        </div>
        <Button disabled={busy || !investorId} onClick={submit}>
          {busy ? 'onboarding…' : 'Onboard'}
        </Button>
        {busy && (
          <span className="text-xs text-amber-700">
            three transactions across two signers — about 15 seconds
          </span>
        )}
      </div>

      {msg && (
        <p className="mt-3 border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          {msg}
        </p>
      )}
      {err && (
        <p className="mt-3 border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {err}
        </p>
      )}

      <p className="mt-4 border-l-2 border-neutral-300 pl-3 text-xs leading-relaxed text-neutral-600">
        The investor signs the trust line; the issuer signs the authorisation and
        the allocation. Two different accounts, and the second cannot run until
        the first has been validated — which is why this is synchronous rather
        than queued.
      </p>
    </Panel>
  )
}
