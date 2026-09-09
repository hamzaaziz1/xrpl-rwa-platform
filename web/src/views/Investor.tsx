/**
 * Investor view.
 *
 * Deliberately the thinnest of the three. An investor holds units and
 * sees their own position — they don't operate anything.
 *
 * The one action available here is accepting a credential, and that is
 * the point: XRPL credentials are two-sided. The verifier issues one,
 * and the subject must sign their own acceptance. Nobody can attach an
 * attribute to your account without your consent.
 */
import { useState } from 'react'
import { api } from '../lib/api'
import type { Snapshot } from '../lib/store'
import { shortAddr, units, explorerAccount } from '../lib/format'
import { Panel, Table, Td, Status, Button, Empty } from '../components/ui'
import { TradingPanel } from '../components/Trading'

export function InvestorView({ platform }: { platform: Snapshot & { refresh?: () => void } }) {
  const { assets, holdings, investors } = platform
  const asset = assets[0]

  const realInvestors = investors.filter(i => i.kyc_status !== 'system')
  const [selected, setSelected] = useState<string | null>(null)
  const [accepting, setAccepting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const me = realInvestors.find(i => i.investor_id === selected) ?? realInvestors[0]
  const myHolding = holdings.find(h => h.account === me?.account)

  if (!asset || !me) return <Empty>No investors. Run <code>npm run seed</code>.</Empty>

  const outstanding = Number(asset.units_outstanding) || 0
  const mine = Number(myHolding?.balance ?? 0)
  const share = outstanding > 0 ? (mine / outstanding) * 100 : 0

  // derived from the credential projection, not a stored column
  const issued = me.kyc_status === 'issued' || me.kyc_status === 'approved'
  const accepted = me.kyc_status === 'approved'
  const revoked = me.kyc_status === 'revoked'
  const canAccept = me.kyc_status === 'issued'

  // An intent for this account that hasn't resolved yet. Local `accepting`
  // state clears when the POST returns, which is long before the ledger
  // has done anything — so the button would become clickable again mid-flight.
  const inFlight = platform.intents.find(
    i => (i.status === 'pending' || i.status === 'submitted') &&
         JSON.stringify(i).includes(me.account ?? '\u0000'),
  )

  async function acceptCredential() {
    setAccepting(true)
    setErr(null)
    try {
      await api.acceptCredential(me.investor_id)
      platform.refresh?.()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setAccepting(false)
    }
  }

  return (
    <div className="space-y-6">

      <div className="flex items-center gap-2 text-sm">
        <span className="text-neutral-500">Viewing as</span>
        <select
          value={me.investor_id}
          onChange={e => { setSelected(e.target.value); setErr(null) }}
          className="border border-neutral-300 bg-white px-2 py-1 text-sm"
        >
          {realInvestors.map(i => (
            <option key={i.investor_id} value={i.investor_id}>
              {i.legal_name}
            </option>
          ))}
        </select>
        <span className="text-xs text-neutral-400">
          (no authentication — see README)
        </span>
      </div>

      {err && (
        <div className="border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          {err}
        </div>
      )}

      <Panel title="Your position" subtitle={asset.title}>
        <dl className="grid grid-cols-3 gap-6 text-sm">
          <div>
            <dt className="text-xs text-neutral-500">Units held</dt>
            <dd className="mt-1 text-2xl tabular-nums">{units(mine)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Share of issue</dt>
            <dd className="mt-1 text-2xl tabular-nums">{share.toFixed(2)}%</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Account</dt>
            <dd className="mt-1 font-mono text-xs">
              {me.account ? (
                <a href={explorerAccount(me.account)} target="_blank" rel="noreferrer"
                   className="underline decoration-neutral-300 hover:decoration-neutral-600">
                  {shortAddr(me.account, 10)}
                </a>
              ) : '—'}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel
        title="Eligibility"
        subtitle="Trading is restricted to holders of an accepted KYC credential"
        right={
          <Status value={
            revoked ? 'revoked' : accepted ? 'approved' : issued ? 'issued' : 'pending'
          } />
        }
      >
        <Table head={['Stage', 'Status', 'When']}>
          <tr>
            <Td>Application submitted</Td>
            <Td><Status value={me.kyc_submitted ? 'confirmed' : 'pending'} /></Td>
            <Td>
              {me.kyc_submitted
                ? new Date(me.kyc_submitted).toLocaleString('en-GB')
                : '—'}
            </Td>
          </tr>

          <tr>
            <Td>Credential issued by verifier</Td>
            <Td><Status value={issued ? 'confirmed' : 'pending'} /></Td>
            <Td>
              {(me as any).kyc_issued
                ? new Date((me as any).kyc_issued).toLocaleString('en-GB')
                : issued ? 'on ledger' : 'awaiting issuer approval'}
            </Td>
          </tr>

          <tr>
            <Td>Credential accepted by you</Td>
            <Td><Status value={accepted ? 'confirmed' : 'pending'} /></Td>
            <Td>
              {accepted ? (
                me.credential_accepted_at
                  ? new Date(me.credential_accepted_at).toLocaleString('en-GB')
                  : 'on ledger'
              ) : inFlight ? (
                <span className="text-xs text-amber-700">submitting…</span>
              ) : canAccept ? (
                <Button disabled={accepting} onClick={acceptCredential}>
                  {accepting ? 'submitting…' : 'Accept credential'}
                </Button>
              ) : '—'}
            </Td>
          </tr>
        </Table>

        {canAccept && (
          <p className="mt-4 border-l-2 border-amber-400 bg-amber-50 py-2 pl-3 text-xs leading-relaxed text-amber-900">
            A credential has been issued to this account but not yet accepted.
            Until it is, the account is <strong>not</strong> a member of the
            permissioned domain and cannot trade. Accepting requires a signature
            from this account, not the issuer.
          </p>
        )}

        <p className="mt-4 border-l-2 border-neutral-300 pl-3 text-xs leading-relaxed text-neutral-600">
          Credentials on the XRP Ledger are two-sided: the verifier issues one,
          and the subject must separately accept it. An issued but unaccepted
          credential does not grant domain membership, so all three stages must
          complete before this account can trade.
          <br /><br />
          This status is derived from the credential projection — the ledger's
          own record of what exists — rather than a status column the
          application writes.
        </p>
      </Panel>

      {accepted && asset && (
        <TradingPanel
          assetId={asset.asset_id}
          currency={asset.currency}
          me={{ investor_id: me.investor_id, account: me.account }}
          myHolding={myHolding}
          book={platform.book}
          inFlightAccounts={new Set(
            platform.intents
              .filter(i => i.status === 'pending' || i.status === 'submitted')
              .map(i => i.actor),
          )}
          onDone={() => platform.refresh?.()}
        />
      )}

      <Panel title="Register" subtitle="All holders of this asset">
        {holdings.length === 0 ? (
          <Empty>No holders.</Empty>
        ) : (
          <Table head={['Holder', 'Account', 'Units', 'Share']}>
            {holdings.map(h => {
              const pct = outstanding > 0 ? (Number(h.balance) / outstanding) * 100 : 0
              const isMe = h.account === me.account
              return (
                <tr key={h.account} className={isMe ? 'bg-neutral-50' : ''}>
                  <Td>
                    {h.legal_name ?? '—'}
                    {isMe && <span className="ml-2 text-xs text-neutral-400">you</span>}
                  </Td>
                  <Td mono>{shortAddr(h.account)}</Td>
                  <Td right>{units(h.balance)}</Td>
                  <Td right>{pct.toFixed(2)}%</Td>
                </tr>
              )
            })}
          </Table>
        )}
      </Panel>
    </div>
  )
}
